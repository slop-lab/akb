import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import postgres from "postgres"
import { z } from "zod"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { createBackup } from "../src/operations/backup/create.ts"
import { restoreBackup } from "../src/operations/backup/restore.ts"
import { verifyBackupArtifact } from "../src/operations/backup/verify.ts"
import {
  createOwnedDatabase,
  migrateBackupSchema004,
  populateBackupSource004,
  requiredEnvironment,
} from "./postgres-backup-fixture.ts"

const adminUrl = requiredEnvironment("DATABASE_URL")
const pgDumpPath = requiredEnvironment("PG_DUMP_PATH")
const pgRestorePath = requiredEnvironment("PG_RESTORE_PATH")

test("a real format-1 artifact restores through the registered schema-004 to schema-008 upgrade", async (context) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "afw-postgres-backup-legacy-"))
  const admin = postgres(adminUrl, { max: 1 })
  const sourceDatabase = await createOwnedDatabase(admin, adminUrl, "backup_legacy_source")
  const targetDatabase = await createOwnedDatabase(admin, adminUrl, "backup_legacy_target")
  const source = postgres(sourceDatabase.url, { max: 2 })
  const target = postgres(targetDatabase.url, { max: 2 })
  context.after(async () => {
    await source.end({ timeout: 5 })
    await target.end({ timeout: 5 })
    await admin`drop database ${admin(sourceDatabase.name)} with (force)`
    await admin`drop database ${admin(targetDatabase.name)} with (force)`
    await admin`drop role ${admin(sourceDatabase.role)}`
    await admin`drop role ${admin(targetDatabase.role)}`
    await admin.end({ timeout: 5 })
    await rm(root, { recursive: true })
  })
  await migrateBackupSchema004(source)
  const fixture = await populateBackupSource004(source)
  const artifact = join(root, "artifact")
  await createBackup(artifact, sourceDatabase.url, pgDumpPath)

  // When
  const manifest = await verifyBackupArtifact(artifact, pgRestorePath)
  const restored = await restoreBackup({
    artifactDirectory: artifact,
    confirmedDatabase: targetDatabase.name,
    reportPath: join(root, "report.json"),
    databaseUrl: targetDatabase.url,
    pgRestorePath,
  })

  // Then
  assert.equal(manifest.formatVersion, 1)
  assert.equal(restored.activationAllowed, true)
  assert.equal(restored.sourceProfile, "r3-schema-004-public")
  assert.equal(restored.finalProfile, "r4-schema-008-public-v1")
  assert.equal(await authenticateToken(target, fixture.activeToken), undefined)
  const state = await target<
    {
      readonly migrations: number
      readonly active_credentials: number
      readonly legacy_leases: number
      readonly generic_leases: number
    }[]
  >`select
    (select count(*)::integer from schema_migrations) as migrations,
    (select count(*)::integer from principal_credentials where revoked_at is null) as active_credentials,
    (select count(*)::integer from outbox_jobs where state = 'leased') as legacy_leases,
    (select count(*)::integer from entity_outbox_jobs_v1 where state = 'leased') as generic_leases`
  assert.deepEqual(state[0], {
    migrations: 8,
    active_credentials: 0,
    legacy_leases: 0,
    generic_leases: 0,
  })
  const report = z
    .strictObject({
      formatVersion: z.literal(2),
      activationAllowed: z.literal(true),
      recoveryId: z.string().uuid(),
      recoveryAt: z.string().datetime(),
      quarantinePolicyVersion: z.literal(2),
      sourceOverallDigest: z.string().length(64),
      sourceProfile: z.literal("r3-schema-004-public"),
      finalProfile: z.literal("r4-schema-008-public-v1"),
      sourceSchemaFingerprint: z.string().length(64),
      finalSchemaFingerprint: z.string().length(64),
      sourceBaselineDigest: z.string().length(64),
      baselineDigest: z.string().length(64),
      postRecoveryDigest: z.string().length(64),
      counts: z.object({ revokedCredentials: z.number().int().positive() }),
      assertions: z.object({
        activeCredentials: z.literal(0),
        leasedJobs: z.literal(0),
        genericLeasedJobs: z.literal(0),
      }),
      outcomeDigest: z.string().length(64),
      sourceBaselineTables: z.array(z.object({ name: z.string() })),
      baselineTables: z.array(z.object({ name: z.string() })),
      postRecoveryTables: z.array(z.object({ name: z.string() })),
    })
    .parse(JSON.parse(await readFile(join(root, "report.json"), "utf8")))
  assert.equal(report.sourceBaselineTables.length, 16)
  assert.equal(report.baselineTables.length, 48)
})
