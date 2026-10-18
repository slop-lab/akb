import { randomUUID } from "node:crypto"
import { type FileHandle, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBackupClient, hasApplicationTables, validateEmptyTarget } from "./database.ts"
import { backupError } from "./errors.ts"
import { inspectArtifact, openNewReportFile } from "./files.ts"
import { computeMigrationDigest, computeSemanticDigest } from "./manifest.ts"
import { requireToolMajor, runTool, toolConnection } from "./process.ts"
import { computeRecoveryOutcomeDigestV3 } from "./recovery.ts"
import { recoverRestoredDatabase } from "./restore-recovery.ts"
import { listBackupArchive, verifyBackupArtifact } from "./verify.ts"

export async function restoreBackup(input: {
  readonly artifactDirectory: string
  readonly confirmedDatabase: string
  readonly reportPath: string
  readonly databaseUrl: string
  readonly pgRestorePath: string
  readonly artifactAuthenticated?: boolean
  readonly allowUnauthenticatedActivation?: boolean
}): Promise<{
  readonly activationAllowed: boolean
  readonly recoveryId: string
  readonly sourceProfile:
    | "r3-schema-004-public"
    | "r4-schema-008-public-v1"
    | "r4-schema-009-public-v1"
    | "r4-schema-010-public-v1"
    | "r8-schema-016-public-v1"
  readonly finalProfile: "r8-schema-016-public-v1"
}> {
  const connection = toolConnection(input.databaseUrl)
  const recoveryId = randomUUID()
  const recoveryAt = new Date().toISOString()
  const artifactAuthenticated = input.artifactAuthenticated === true
  const activationAllowed = artifactAuthenticated || input.allowUnauthenticatedActivation === true
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
        if (manifest.formatVersion === 2) {
          await sql`create extension pgcrypto with schema public`
        }
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
        const recovery = await sql.begin((transaction) =>
          recoverRestoredDatabase(transaction, manifest, recoveryAt),
        )
        const sourceBaselineDigest = computeSemanticDigest(
          manifest.migrationDigest,
          recovery.sourceBaseline,
        )
        const finalMigrationDigest = computeMigrationDigest(recovery.finalProfile.migrations)
        const baselineDigest = computeSemanticDigest(finalMigrationDigest, recovery.finalBaseline)
        const postRecoveryDigest = computeSemanticDigest(
          finalMigrationDigest,
          recovery.postRecovery,
        )
        const outcome = {
          sourceOverallDigest: manifest.overallDigest,
          sourceProfile: recovery.sourceProfile.id,
          finalProfile: recovery.finalProfile.id,
          sourceSchemaFingerprint: manifest.schemaFingerprint,
          finalSchemaFingerprint: recovery.finalProfile.schemaFingerprint,
          sourceBaselineDigest,
          baselineDigest,
          postRecoveryDigest,
          counts: recovery.counts,
          assertions: recovery.assertions,
        }
        const report = {
          formatVersion: 2,
          activationAllowed,
          artifactAuthenticated,
          recoveryId,
          recoveryAt,
          quarantinePolicyVersion: 3,
          ...outcome,
          outcomeDigest: computeRecoveryOutcomeDigestV3(outcome),
          sourceBaselineTables: recovery.sourceBaseline,
          baselineTables: recovery.finalBaseline,
          postRecoveryTables: recovery.postRecovery,
        }
        await writePrivateReport(reportFile, report)
        return {
          activationAllowed,
          recoveryId,
          sourceProfile: recovery.sourceProfile.id,
          finalProfile: "r8-schema-016-public-v1",
        }
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
