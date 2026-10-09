import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { readMigrationCatalog } from "../../postgres/migrate.ts"
import {
  createBackupClient,
  digestTables,
  hasApplicationTables,
  validateApplicationDatabase,
  validateEmptyTarget,
} from "./database.ts"
import { backupError } from "./errors.ts"
import { inspectArtifact, openNewReportFile } from "./files.ts"
import { computeSemanticDigest, type BackupManifest, type TableDigest } from "./manifest.ts"
import { requireToolMajor, runTool, toolConnection } from "./process.ts"
import {
  computeRecoveryOutcomeDigest,
  quarantineAssertions,
  type QuarantineAssertions,
} from "./recovery.ts"
import { listBackupArchive, verifyBackupArtifact } from "./verify.ts"

type RecoveryCounts = {
  readonly revokedCredentials: number
  readonly leasedToPending: number
  readonly leasedToDeadLetter: number
  readonly generationIncrements: number
}

export async function restoreBackup(input: {
  readonly artifactDirectory: string
  readonly confirmedDatabase: string
  readonly reportPath: string
  readonly databaseUrl: string
  readonly pgRestorePath: string
}): Promise<{ readonly activationAllowed: true; readonly recoveryId: string }> {
  const connection = toolConnection(input.databaseUrl)
  const recoveryId = randomUUID()
  const recoveryAt = new Date().toISOString()
  const restoreListDirectory = await mkdtemp(join(tmpdir(), "afw-restore-list-"))
  const restoreListPath = join(restoreListDirectory, "toc.list")
  try {
    const reportFile = await openNewReportFile(input.reportPath)
    try {
      const sql = createBackupClient(input.databaseUrl)
      try {
        const manifest = await verifyBackupArtifact(input.artifactDirectory, input.pgRestorePath)
        const paths = await inspectArtifact(input.artifactDirectory)
        await validateEmptyTarget(sql, input.confirmedDatabase)
        await requireToolMajor(input.pgRestorePath)
        const archiveList = await listBackupArchive(input.pgRestorePath, paths.archive)
        const restoreList = archiveList
          .split("\n")
          .filter((line) => !/^\d+; \d+ \d+ SCHEMA - public /.test(line))
          .join("\n")
        await writeFile(restoreListPath, restoreList, { mode: 0o600, flag: "wx" })
        await runTool({
          path: input.pgRestorePath,
          args: [
            ...connection.args,
            "--single-transaction",
            "--exit-on-error",
            "--no-owner",
            "--no-acl",
            "--no-tablespaces",
            "--no-publications",
            "--no-subscriptions",
            "--no-security-labels",
            "--no-password",
            `--use-list=${restoreListPath}`,
            paths.archive,
          ],
          environment: connection.environment,
          secrets: connection.secrets,
        })
        const recovery = await quarantineRestoredDatabase(sql, manifest, recoveryAt)
        const baselineDigest = computeSemanticDigest(manifest.migrationDigest, recovery.baseline)
        const postRecoveryDigest = computeSemanticDigest(
          manifest.migrationDigest,
          recovery.postRecovery,
        )
        const outcome = {
          sourceOverallDigest: manifest.overallDigest,
          schemaFingerprint: manifest.schemaFingerprint,
          baselineDigest,
          postRecoveryDigest,
          counts: recovery.counts,
          assertions: recovery.assertions,
        }
        const report = {
          formatVersion: 1,
          activationAllowed: true,
          recoveryId,
          recoveryAt,
          quarantinePolicyVersion: 1,
          ...outcome,
          outcomeDigest: computeRecoveryOutcomeDigest(outcome),
          baselineTables: recovery.baseline,
          postRecoveryTables: recovery.postRecovery,
        }
        await writePrivateReport(reportFile, report)
        return { activationAllowed: true, recoveryId }
      } catch (error) {
        await writePrivateReport(reportFile, {
          formatVersion: 1,
          activationAllowed: false,
          recoveryId,
          recoveryAt,
          targetPopulated: await hasApplicationTables(sql).then(
            (populated) => populated,
            () => "unknown" as const,
          ),
          errorCode:
            error instanceof Error && "code" in error ? String(error.code) : "restore_failed",
        }).catch(() => undefined)
        throw error
      } finally {
        await sql.end({ timeout: 5 })
      }
    } finally {
      await reportFile.close()
    }
  } finally {
    await rm(restoreListDirectory, { recursive: true })
  }
}

async function quarantineRestoredDatabase(
  sql: ReturnType<typeof createBackupClient>,
  manifest: BackupManifest,
  recoveryAt: string,
): Promise<{
  readonly baseline: readonly TableDigest[]
  readonly postRecovery: readonly TableDigest[]
  readonly counts: RecoveryCounts
  readonly assertions: QuarantineAssertions
}> {
  const catalog = await readMigrationCatalog()
  const migrations = catalog.map(({ version, checksum }) => ({ name: version, checksum }))
  return sql.begin(async (transaction) => {
    await transaction`lock table principal_credentials, outbox_jobs in access exclusive mode`
    await validateApplicationDatabase(transaction, migrations)
    const baseline = await digestTables(transaction)
    if (JSON.stringify(baseline) !== JSON.stringify(manifest.tables)) {
      throw backupError(
        "restored_digest_mismatch",
        "restored baseline does not match backup manifest",
      )
    }
    const protectedBaseline = await digestTables(transaction, "protected")
    const overflow = await transaction`select exists (
      select 1 from outbox_jobs where state = 'leased' and lease_generation = 9223372036854775807
    ) as value`
    if (z.strictObject({ value: z.boolean() }).parse(overflow[0]).value) {
      throw backupError("lease_generation_overflow", "restored lease generation cannot be fenced")
    }
    const credentialRows = await transaction`with revoked as (
      update principal_credentials set revoked_at = ${recoveryAt} where revoked_at is null returning 1
    ) select count(*)::integer as value from revoked`
    const jobRows = await transaction`with fenced as (
      update outbox_jobs set state = case when attempts >= 5 then 'dead_letter' else 'pending' end,
        lease_owner = null, lease_expires_at = null, lease_generation = lease_generation + 1
      where state = 'leased' returning state
    ) select count(*) filter (where state = 'pending')::integer as pending,
      count(*) filter (where state = 'dead_letter')::integer as dead from fenced`
    const revokedCredentials = z
      .strictObject({ value: z.number().int() })
      .parse(credentialRows[0]).value
    const jobs = z
      .strictObject({ pending: z.number().int(), dead: z.number().int() })
      .parse(jobRows[0])
    const postRecovery = await digestTables(transaction)
    const protectedPost = await digestTables(transaction, "protected")
    assertProtectedTransformation(baseline, postRecovery, protectedBaseline, protectedPost)
    const assertionRows = await transaction`select
      (select count(*)::integer from principal_credentials where revoked_at is null) as active_credentials,
      (select count(*)::integer from outbox_jobs where state = 'leased') as leased_jobs`
    const remaining = z
      .strictObject({
        active_credentials: z.number().int().nonnegative(),
        leased_jobs: z.number().int().nonnegative(),
      })
      .parse(assertionRows[0])
    const assertions = quarantineAssertions({
      activeCredentials: remaining.active_credentials,
      leasedJobs: remaining.leased_jobs,
    })
    return {
      baseline,
      postRecovery,
      assertions,
      counts: {
        revokedCredentials,
        leasedToPending: jobs.pending,
        leasedToDeadLetter: jobs.dead,
        generationIncrements: jobs.pending + jobs.dead,
      },
    }
  })
}

function assertProtectedTransformation(
  baseline: readonly TableDigest[],
  postRecovery: readonly TableDigest[],
  protectedBaseline: readonly TableDigest[],
  protectedPost: readonly TableDigest[],
): void {
  const mutable = new Set(["principal_credentials", "outbox_jobs"])
  for (let index = 0; index < baseline.length; index += 1) {
    const before = baseline[index]
    const after = postRecovery[index]
    if (before === undefined || after === undefined)
      throw backupError("quarantine_failed", "table digest missing")
    if (!mutable.has(before.name) && JSON.stringify(before) !== JSON.stringify(after)) {
      throw backupError("quarantine_failed", "recovery changed protected application data")
    }
  }
  if (JSON.stringify(protectedBaseline) !== JSON.stringify(protectedPost)) {
    throw backupError("quarantine_failed", "recovery changed protected credential or job columns")
  }
}

async function writePrivateReport(handle: FileHandle, report: object): Promise<void> {
  const serialized = Buffer.from(`${JSON.stringify(report, null, 2)}\n`)
  await handle.truncate(0)
  let offset = 0
  while (offset < serialized.length) {
    const { bytesWritten } = await handle.write(
      serialized,
      offset,
      serialized.length - offset,
      offset,
    )
    if (bytesWritten === 0)
      throw backupError("report_write_failed", "recovery report write stalled")
    offset += bytesWritten
  }
  await handle.sync()
}
