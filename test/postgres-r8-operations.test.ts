import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import postgres from "postgres"
import { z } from "zod"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { schemaFingerprint } from "../src/operations/backup/catalog.ts"
import { PROFILE_016 } from "../src/operations/backup/profiles.ts"
import { quarantineCurrentAuthority } from "../src/operations/backup/quarantine-r8.ts"
import { runBackupCli } from "../src/operations/backup/run.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { createOwnedDatabase, requiredEnvironment } from "./postgres-backup-fixture.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

test("profile 016 fingerprint and semantic table catalog match pristine PostgreSQL 17", async (context) => {
  // Given
  const adminUrl = requiredEnvironment("DATABASE_URL")
  const admin = postgres(adminUrl, { max: 1 })
  const database = await createOwnedDatabase(admin, adminUrl, "profile_016")
  const sql = postgres(database.url, { max: 1 })
  context.after(async () => {
    await sql.end({ timeout: 5 })
    await admin`drop database ${admin(database.name)} with (force)`
    await admin`drop role ${admin(database.role)}`
    await admin.end({ timeout: 5 })
  })
  await migrateDatabase(sql)

  // When
  const actual = await sql.begin((transaction) => schemaFingerprint(transaction))
  const tableRows = await sql<{ readonly name: string }[]>`
    select tablename::text as name from pg_tables
    where schemaname='public' and tablename<>'schema_migrations'
    order by tablename`

  // Then
  assert.equal(actual, PROFILE_016.schemaFingerprint)
  assert.deepEqual(
    PROFILE_016.tables.map(({ name }) => name).toSorted(),
    tableRows.map(({ name }) => name),
  )
})

test("restore quarantine expires run authority and disables integration delivery", async (context) => {
  // Given
  const fixture = await createPostgresTestFixture()
  context.after(fixture.close)
  const admin = new IdentityAdmin(fixture.sql)
  await admin.bootstrapWorkspace({
    workspaceId: "quarantine",
    workspaceName: "Quarantine",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await seedQuarantinedAuthority(fixture.sql)
  const recoveryAt = "2026-10-17T12:00:00.000Z"

  // When
  const result = await fixture.sql.begin((transaction) =>
    quarantineCurrentAuthority(transaction, recoveryAt),
  )

  // Then
  assert.equal(result.counts.revokedRunCredentials, 1)
  assert.equal(result.counts.expiredRuntimeLeases, 1)
  assert.equal(result.counts.disabledRuntimeCapabilities, 3)
  assert.equal(result.counts.rotatedIntegrationCredentials, 1)
  assert.equal(result.counts.quarantinedDeliveryJobs, 2)
  assert.deepEqual(result.assertions, {
    activeCredentials: 0,
    leasedJobs: 0,
    genericLeasedJobs: 0,
    activeRunCredentials: 0,
    activeRuntimeLeases: 0,
    enabledRuntimeCapabilities: 0,
    runtimeContextSnapshots: 0,
    enabledIntegrations: 0,
    dispatchableDeliveryJobs: 0,
  })
  const [state] = await fixture.sql`select
    (select enabled from extension_installations where id='extension') extension_enabled,
    (select state from github_webhook_deliveries where delivery_id='delivery') github_state,
    (select state from outgoing_https_requests limit 1) outgoing_state,
    (select lease_owner is null from outgoing_https_requests limit 1) outgoing_lease_cleared,
    (select last_sequence from automation_event_checkpoints
      where workspace_id='quarantine') checkpoint_sequence`
  assert.deepEqual(state, {
    extension_enabled: false,
    github_state: "dead_letter",
    outgoing_state: "dead_letter",
    outgoing_lease_cleared: true,
    checkpoint_sequence: "42",
  })
})

test("backup CLI encrypts, authenticates, and restores a profile 016 artifact", async (context) => {
  // Given
  const adminUrl = requiredEnvironment("DATABASE_URL")
  const pgDumpPath = requiredEnvironment("PG_DUMP_PATH")
  const pgRestorePath = requiredEnvironment("PG_RESTORE_PATH")
  const admin = postgres(adminUrl, { max: 1 })
  const source = await createOwnedDatabase(admin, adminUrl, "encrypted_source")
  const target = await createOwnedDatabase(admin, adminUrl, "encrypted_target")
  const sourceSql = postgres(source.url, { max: 1 })
  await migrateDatabase(sourceSql)
  const adminIdentity = new IdentityAdmin(sourceSql)
  await adminIdentity.bootstrapWorkspace({
    workspaceId: "quarantine",
    workspaceName: "Quarantine",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await seedQuarantinedAuthority(sourceSql)
  await sourceSql.end({ timeout: 5 })
  const root = await mkdtemp(join(tmpdir(), "afw-encrypted-e2e-"))
  const artifact = join(root, "artifact")
  const report = join(root, "report.json")
  const key = Buffer.alloc(32, 11).toString("base64url")
  context.after(async () => {
    await admin`drop database ${admin(source.name)} with (force)`
    await admin`drop database ${admin(target.name)} with (force)`
    await admin`drop role ${admin(source.role)}`
    await admin`drop role ${admin(target.role)}`
    await admin.end({ timeout: 5 })
    await rm(root, { recursive: true })
  })

  // When
  const created = z.object({ encryptedAtRest: z.literal(true) }).parse(
    JSON.parse(
      await runBackupCli(["create", "--artifact-dir", artifact], {
        SOURCE_DATABASE_URL: source.url,
        BACKUP_ENCRYPTION_KEY: key,
        PG_DUMP_PATH: pgDumpPath,
      }),
    ),
  )
  const verified = z.object({ authenticityVerified: z.literal(true) }).parse(
    JSON.parse(
      await runBackupCli(["verify", "--artifact-dir", artifact], {
        BACKUP_ENCRYPTION_KEY: key,
        PG_RESTORE_PATH: pgRestorePath,
      }),
    ),
  )
  const restored = z
    .object({
      activationAllowed: z.literal(true),
      finalProfile: z.literal("r8-schema-016-public-v1"),
    })
    .parse(
      JSON.parse(
        await runBackupCli(
          [
            "restore",
            "--artifact-dir",
            artifact,
            "--confirm-empty-database",
            target.name,
            "--report",
            report,
          ],
          {
            RESTORE_DATABASE_URL: target.url,
            BACKUP_ENCRYPTION_KEY: key,
            PG_RESTORE_PATH: pgRestorePath,
          },
        ),
      ),
    )

  // Then
  assert.deepEqual((await readdir(artifact)).sort(), ["envelope.json", "payload.enc"])
  assert.equal(created.encryptedAtRest, true)
  assert.equal(verified.authenticityVerified, true)
  assert.equal(restored.activationAllowed, true)
  assert.equal(restored.finalProfile, PROFILE_016.id)
  const targetSql = postgres(target.url, { max: 1 })
  const [checkpoint] = await targetSql<{ readonly last_sequence: string }[]>`
    select last_sequence::text from automation_event_checkpoints where workspace_id='quarantine'`
  await targetSql.end({ timeout: 5 })
  assert.deepEqual(checkpoint, { last_sequence: "42" })
})

async function seedQuarantinedAuthority(sql: ReturnType<typeof postgres>): Promise<void> {
  const tokenHash = Buffer.alloc(32, 1)
  await sql`insert into automation_event_checkpoints(workspace_id,last_sequence)
    values ('quarantine',42)`
  await sql`insert into runtime_endpoints
    (workspace_id,id,protocol_version,mode,supported_roles,supported_capabilities,
      max_concurrency,heartbeat_seconds)
    values ('quarantine','endpoint','runtime.v1','pull','[]','[]',1,30)`
  await sql`insert into agent_definitions(workspace_id,id,display_name,created_by)
    values ('quarantine','definition','Definition','owner')`
  await sql`insert into agent_definition_revisions
    (id,workspace_id,definition_id,roles,required_capabilities,manifest,digest,created_by)
    values ('revision','quarantine','definition','[]','[]','{}',repeat('a',64),'owner')`
  await sql`insert into agent_installations
    (workspace_id,id,definition_revision_id,runtime_endpoint_id,principal_id,scopes,
      permissions,capabilities,mentionable,delegatable,created_by)
    values ('quarantine','installation','revision','endpoint','owner','[]','[]','[]',true,true,'owner')`
  await sql`insert into runtime_sessions(id,workspace_id,installation_id,subject_ref,directive_ref,requester_id)
    values ('session','quarantine','installation','subject','directive','owner')`
  await sql`insert into runtime_runs
    (id,workspace_id,session_id,installation_id,depth,state,generation,subject_ref,directive_ref,
      requester_id,policy_snapshot,token_hash,token_expires_at)
    values ('run','quarantine','session','installation',0,'running',1,'subject','directive',
      'owner','{}',${tokenHash},'2030-01-01T00:00:00Z')`
  await sql`insert into runtime_leases(run_id,generation,owner,status,expires_at,heartbeat_deadline)
    values ('run',1,'worker','acknowledged','2030-01-01T00:00:00Z','2030-01-01T00:00:00Z')`
  for (const [id, kind] of [
    ["github", "github_installation"],
    ["extension", "extension_installation"],
  ] as const) {
    await sql`insert into entities(id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
      values (${id},'quarantine',${kind},1,'owner',clock_timestamp(),clock_timestamp())`
    await sql`insert into entity_acl_policies(entity_id,mode) values (${id},'inherit')`
  }
  await sql`insert into github_installations
    (id,workspace_id,external_installation_id,repository,webhook_secret,api_base_url,
      allowed_hosts,revision,created_by,created_at)
    values ('github','quarantine','external','owner/repository',${Buffer.alloc(32, 2)},
       'https://api.github.com',array['api.github.com'],1,'owner',clock_timestamp())`
  await sql`insert into github_webhook_deliveries
    (installation_id,delivery_id,event_name,payload,received_at,state,available_at)
    values ('github','delivery','issues','{}',clock_timestamp(),'processing',clock_timestamp())`
  await sql`insert into extension_manifests
    (manifest_id,version,protocol_version,manifest,digest,submitted_by,submitted_at)
    values ('manifest','1','extension.v1','{}',repeat('b',64),'owner',clock_timestamp())`
  await sql`insert into extension_installations
    (id,workspace_id,manifest_id,manifest_version,approved_permissions,endpoint_url,revision,
      approved_by,approved_at)
    values ('extension','quarantine','manifest','1','{}','https://example.com',1,
      'owner',clock_timestamp())`
  await sql`insert into outgoing_https_requests
    (id,workspace_id,endpoint_kind,endpoint_id,url,method,body,state,available_at,created_at,
      lease_owner,lease_generation,lease_expires_at)
    values (${randomUUID()},'quarantine','github','github','https://api.github.com/hook',
      'POST','{}','delivering',clock_timestamp(),clock_timestamp(),${randomUUID()},4,
      '2030-01-01T00:00:00Z')`
}
