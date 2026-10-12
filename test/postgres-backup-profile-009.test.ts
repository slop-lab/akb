import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import postgres from "postgres"
import { createBackup } from "../src/operations/backup/create.ts"
import { restoreBackup } from "../src/operations/backup/restore.ts"
import {
  createOwnedDatabase,
  migrateBackupSchema004,
  migrateBackupSchema009,
  populateBackupSource004,
  populateR4BackupState,
  requiredEnvironment,
} from "./postgres-backup-fixture.ts"

const adminUrl = requiredEnvironment("DATABASE_URL")
const pgDumpPath = requiredEnvironment("PG_DUMP_PATH")
const pgRestorePath = requiredEnvironment("PG_RESTORE_PATH")

test("a real profile-009 artifact restores through the registered schema-010 upgrade", async (context) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "afw-postgres-backup-009-"))
  const admin = postgres(adminUrl, { max: 1 })
  const sourceDatabase = await createOwnedDatabase(admin, adminUrl, "backup_009_source")
  const targetDatabase = await createOwnedDatabase(admin, adminUrl, "backup_009_target")
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
  await populateBackupSource004(source)
  await migrateBackupSchema009(source)
  await populateR4BackupState(source)
  const historyBefore = await source`select entity_id,revision,schema_version,canonical_snapshot,
    actor_id,cause_event_id,created_at,digest from entity_revisions order by entity_id,revision`
  const artifact = join(root, "artifact")
  await createBackup(artifact, sourceDatabase.url, pgDumpPath)

  // When
  const restored = await restoreBackup({
    artifactDirectory: artifact,
    confirmedDatabase: targetDatabase.name,
    reportPath: join(root, "report.json"),
    databaseUrl: targetDatabase.url,
    pgRestorePath,
  })

  // Then
  assert.equal(restored.sourceProfile, "r4-schema-009-public-v1")
  assert.equal(restored.finalProfile, "r4-schema-010-public-v1")
  assert.deepEqual(
    [
      ...(await target`select entity_id,revision,schema_version,canonical_snapshot,
      actor_id,cause_event_id,created_at,digest from entity_revisions order by entity_id,revision`),
    ],
    [...historyBefore],
  )
  const [state] = await target`select
    (select count(*)::integer from schema_migrations) migrations,
    (select count(*)::integer from principal_credentials where revoked_at is null) active,
    (select count(*)::integer from outbox_jobs where state='leased') legacy_leases,
    (select count(*)::integer from entity_outbox_jobs_v1 where state='leased') generic_leases,
    (select count(*)::integer from human_query_snapshots) snapshots`
  assert.deepEqual(state, {
    migrations: 10,
    active: 0,
    legacy_leases: 0,
    generic_leases: 0,
    snapshots: 0,
  })
})
