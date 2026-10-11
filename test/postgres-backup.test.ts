import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import postgres from "postgres"
import { z } from "zod"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { createBackup } from "../src/operations/backup/create.ts"
import { digestTables, validateApplicationDatabase } from "../src/operations/backup/database.ts"
import { restoreBackup } from "../src/operations/backup/restore.ts"
import { verifyBackupArtifact } from "../src/operations/backup/verify.ts"
import { OutboxRepository } from "../src/outbox/repository.ts"
import { migrateDatabase, readMigrationCatalog } from "../src/postgres/migrate.ts"
import {
  createOwnedDatabase,
  databaseUrl,
  migrateBackupSchema004,
  populateBackupSource004,
  populateR4BackupState,
  requiredEnvironment,
  waitForExportedSnapshot,
} from "./postgres-backup-fixture.ts"

const adminUrl = requiredEnvironment("DATABASE_URL")
const pgDumpPath = requiredEnvironment("PG_DUMP_PATH")
const pgRestorePath = requiredEnvironment("PG_RESTORE_PATH")

test("schema validation rejects extra views and changed routine definitions", async (context) => {
  // Given
  const suffix = randomUUID().replaceAll("-", "")
  const viewDatabase = `backup_shape_view_${suffix}`
  const routineDatabase = `backup_shape_routine_${suffix}`
  const admin = postgres(adminUrl, { max: 1 })
  await admin`create database ${admin(viewDatabase)} template template0`
  await admin`create database ${admin(routineDatabase)} template template0`
  const viewSql = postgres(databaseUrl(adminUrl, viewDatabase), { max: 1 })
  const routineSql = postgres(databaseUrl(adminUrl, routineDatabase), { max: 1 })
  context.after(async () => {
    await viewSql.end({ timeout: 5 })
    await routineSql.end({ timeout: 5 })
    await admin`drop database ${admin(viewDatabase)} with (force)`
    await admin`drop database ${admin(routineDatabase)} with (force)`
    await admin.end({ timeout: 5 })
  })
  await migrateDatabase(viewSql)
  await migrateDatabase(routineSql)
  const migrations = (await readMigrationCatalog()).map(({ version, checksum }) => ({
    name: version,
    checksum,
  }))
  await viewSql`create view unexpected_backup_view as select 1 as value`
  await routineSql.unsafe(`create or replace function reject_work_item_scope_mutation()
    returns trigger language plpgsql as $$ begin return new; end $$`)

  // When / Then
  await assert.rejects(
    viewSql.begin((transaction) => validateApplicationDatabase(transaction, migrations)),
    /fingerprint/,
  )
  await assert.rejects(
    routineSql.begin((transaction) => validateApplicationDatabase(transaction, migrations)),
    /fingerprint/,
  )
})

test("table digests are identical under hostile session formatting", async (context) => {
  // Given
  const database = `backup_digest_${randomUUID().replaceAll("-", "")}`
  const admin = postgres(adminUrl, { max: 1 })
  await admin`create database ${admin(database)} template template0`
  const first = postgres(databaseUrl(adminUrl, database), { max: 1 })
  const second = postgres(databaseUrl(adminUrl, database), { max: 1 })
  context.after(async () => {
    await first.end({ timeout: 5 })
    await second.end({ timeout: 5 })
    await admin`drop database ${admin(database)} with (force)`
    await admin.end({ timeout: 5 })
  })
  await migrateBackupSchema004(first)
  await populateBackupSource004(first)
  await migrateDatabase(first)
  await first`set timezone = 'America/Los_Angeles'`
  await first`set datestyle = 'SQL, DMY'`
  await first`set bytea_output = 'escape'`
  await second`set timezone = 'Asia/Tokyo'`
  await second`set datestyle = 'Postgres, MDY'`
  await second`set bytea_output = 'hex'`

  // When
  const firstDigest = await first.begin((transaction) => digestTables(transaction))
  const secondDigest = await second.begin((transaction) => digestTables(transaction))

  // Then
  assert.deepEqual(firstDigest, secondDigest)
})

test("PostgreSQL 17 backup restores across ordinary database owners and quarantines credentials and leases", async (context) => {
  // Given
  const artifactRoot = await mkdtemp(join(tmpdir(), "afw-postgres-backup-"))
  const artifactDirectory = join(artifactRoot, "artifact")
  const admin = postgres(adminUrl, { max: 1 })
  const sourceDatabase = await createOwnedDatabase(admin, adminUrl, "backup_source")
  const targetDatabase = await createOwnedDatabase(admin, adminUrl, "backup_target")
  const source = postgres(sourceDatabase.url, { max: 4 })
  const target = postgres(targetDatabase.url, { max: 4 })
  const { BACKUP_KEEP_FIXTURE: keepFixture } = process.env
  context.after(async () => {
    await source.end({ timeout: 5 })
    await target.end({ timeout: 5 })
    if (keepFixture !== "1") {
      await admin`drop database ${admin(sourceDatabase.name)} with (force)`
      await admin`drop database ${admin(targetDatabase.name)} with (force)`
      await admin`drop role ${admin(sourceDatabase.role)}`
      await admin`drop role ${admin(targetDatabase.role)}`
      await rm(artifactRoot, { recursive: true })
    }
    await admin.end({ timeout: 5 })
  })
  await migrateBackupSchema004(source)
  const fixture = await populateBackupSource004(source)
  await migrateDatabase(source)
  await populateR4BackupState(source)
  await source`insert into workspaces (id, name)
    select 'bulk-' || value::text, 'Bulk ' || value::text from generate_series(1, 10000) value`

  // When
  const creation = createBackup(artifactDirectory, sourceDatabase.url, pgDumpPath)
  await waitForExportedSnapshot(admin, sourceDatabase.name)
  await source`insert into workspaces (id, name) values ('after-snapshot', 'After snapshot')`
  const created = await creation

  // Then
  assert.match(created.overallDigest, /^[0-9a-f]{64}$/)
  const tamperedDirectory = join(artifactRoot, "tampered")
  await mkdir(tamperedDirectory, { mode: 0o700 })
  await copyFile(join(artifactDirectory, "archive.dump"), join(tamperedDirectory, "archive.dump"))
  await copyFile(join(artifactDirectory, "manifest.json"), join(tamperedDirectory, "manifest.json"))
  await chmod(join(tamperedDirectory, "archive.dump"), 0o600)
  await chmod(join(tamperedDirectory, "manifest.json"), 0o600)
  await appendFile(join(tamperedDirectory, "archive.dump"), "tamper")
  await assert.rejects(verifyBackupArtifact(tamperedDirectory, pgRestorePath), /digest/)
  const tamperedReport = join(artifactRoot, "tampered-report.json")
  await assert.rejects(
    restoreBackup({
      artifactDirectory: tamperedDirectory,
      confirmedDatabase: targetDatabase.name,
      reportPath: tamperedReport,
      databaseUrl: targetDatabase.url,
      pgRestorePath,
    }),
    /digest/,
  )
  const failedRecovery = z
    .strictObject({
      formatVersion: z.literal(1),
      activationAllowed: z.literal(false),
      recoveryId: z.string().uuid(),
      recoveryAt: z.string().datetime(),
      targetPopulated: z.literal(false),
      errorCode: z.literal("archive_digest_mismatch"),
    })
    .parse(JSON.parse(await readFile(tamperedReport, "utf8")))
  assert.equal(failedRecovery.activationAllowed, false)
  const occupiedReport = join(artifactRoot, "occupied-report.json")
  await writeFile(occupiedReport, "occupied", { mode: 0o600 })
  await assert.rejects(
    restoreBackup({
      artifactDirectory,
      confirmedDatabase: targetDatabase.name,
      reportPath: occupiedReport,
      databaseUrl: targetDatabase.url,
      pgRestorePath,
    }),
    /new path/,
  )
  await assert.rejects(
    restoreBackup({
      artifactDirectory,
      confirmedDatabase: "wrong-name",
      reportPath: join(artifactRoot, "wrong-name-report.json"),
      databaseUrl: targetDatabase.url,
      pgRestorePath,
    }),
    /confirmation/,
  )
  const blocker = postgres(targetDatabase.url, { max: 1 })
  context.after(() => blocker.end({ timeout: 5 }))
  await blocker`select 1`
  await assert.rejects(
    restoreBackup({
      artifactDirectory,
      confirmedDatabase: targetDatabase.name,
      reportPath: join(artifactRoot, "session-report.json"),
      databaseUrl: targetDatabase.url,
      pgRestorePath,
    }),
    /pristine/,
  )
  await blocker.end({ timeout: 5 })
  const restored = await restoreBackup({
    artifactDirectory,
    confirmedDatabase: targetDatabase.name,
    reportPath: join(artifactRoot, "recovery-report.json"),
    databaseUrl: targetDatabase.url,
    pgRestorePath,
  })
  assert.equal(restored.activationAllowed, true)
  assert.equal(restored.sourceProfile, "r4-schema-008-public-v1")
  assert.equal(restored.finalProfile, "r4-schema-008-public-v1")
  const quarantineCounts = await target<
    {
      readonly active: number
      readonly leased: number
      readonly generic_leased: number
      readonly snapshots: number
      readonly validated_imports: number
      readonly committed_imports: number
      readonly committed_mappings: number
      readonly generic_commands: number
    }[]
  >`select
    (select count(*)::integer from principal_credentials where revoked_at is null) as active,
    (select count(*)::integer from outbox_jobs where state = 'leased') as leased,
    (select count(*)::integer from entity_outbox_jobs_v1 where state = 'leased') as generic_leased,
    (select count(*)::integer from human_query_snapshots) as snapshots,
    (select count(*)::integer from import_batches where state = 'validated') as validated_imports,
    (select count(*)::integer from import_batches where state = 'committed') as committed_imports,
    (select count(*)::integer from import_record_ids r join import_batches b using (import_id)
      where b.state = 'committed') as committed_mappings,
    (select count(*)::integer from generic_command_idempotency) as generic_commands`
  assert.deepEqual(quarantineCounts[0], {
    active: 0,
    leased: 0,
    generic_leased: 0,
    snapshots: 0,
    validated_imports: 0,
    committed_imports: 1,
    committed_mappings: 1,
    generic_commands: 1,
  })
  assert.equal(await authenticateToken(target, fixture.activeToken), undefined)
  const fresh = await new IdentityAdmin(target).issueToken({
    workspaceId: "workspace",
    principalId: "admin",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  assert.equal((await authenticateToken(target, fresh.token))?.principalId, "admin")
  assert.equal(await new OutboxRepository(target).acknowledge(fixture.staleDelivery), false)
  await new OutboxRepository(target).deliverToInbox(fixture.staleDelivery)
  await new OutboxRepository(target).deliverToInbox(fixture.staleDelivery)
  const counts = await target<{ readonly inbox: number; readonly late: number }[]>`
    select
      (select count(*)::integer from delivery_inbox where event_id = ${fixture.staleDelivery.eventId}) as inbox,
      (select count(*)::integer from workspaces where id = 'after-snapshot') as late`
  assert.deepEqual({ ...counts[0] }, { inbox: 1, late: 0 })
  const states = await target<
    { readonly sequence: number; readonly state: string; readonly attempts: number }[]
  >`
    select sequence::integer as sequence, state, attempts from outbox_jobs order by sequence`
  assert.deepEqual(
    states.map(({ sequence, state, attempts }) => [sequence, state, attempts]),
    [
      [1, "pending", 0],
      [2, "pending", 1],
      [3, "dead_letter", 5],
      [4, "delivered", 1],
      [5, "dead_letter", 5],
    ],
  )
  await assert.rejects(
    restoreBackup({
      artifactDirectory,
      confirmedDatabase: targetDatabase.name,
      reportPath: join(artifactRoot, "nonempty-report.json"),
      databaseUrl: targetDatabase.url,
      pgRestorePath,
    }),
    /pristine/,
  )
  if (keepFixture === "1") {
    context.diagnostic(
      JSON.stringify([sourceDatabase.name, targetDatabase.name, artifactDirectory]),
    )
  }
})
