import { createHash, randomBytes, randomUUID } from "node:crypto"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import type { Sql } from "postgres"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { PROFILE_004 } from "../src/operations/backup/profiles.ts"
import { type ClaimedDelivery, OutboxRepository } from "../src/outbox/repository.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"

export type OwnedDatabase = {
  readonly name: string
  readonly role: string
  readonly url: string
}

export async function createOwnedDatabase(
  admin: Sql,
  adminUrl: string,
  prefix: string,
): Promise<OwnedDatabase> {
  const suffix = randomUUID().replaceAll("-", "")
  const name = `${prefix}_${suffix}`
  const role = `${prefix}_owner_${suffix}`
  const password = randomBytes(32).toString("hex")
  await admin.unsafe(`create role "${role}" login password '${password}'`)
  await admin`create database ${admin(name)} owner ${admin(role)} template template0`
  const url = new URL(adminUrl)
  url.username = role
  url.password = password
  url.pathname = `/${name}`
  return { name, role, url: url.toString() }
}

export async function populateBackupSource(sql: Sql): Promise<{
  readonly activeToken: string
  readonly staleDelivery: ClaimedDelivery
}> {
  const identity = new IdentityAdmin(sql)
  const active = await identity.bootstrapWorkspace({
    workspaceId: "workspace",
    workspaceName: "Workspace",
    principalId: "admin",
    principalName: "Admin",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const revoked = await identity.issueToken({
    workspaceId: "workspace",
    principalId: "admin",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await identity.revokeToken({ credentialId: revoked.credentialId })
  return populateBackupRows(sql, active.token)
}

export async function populateBackupSource004(sql: Sql): Promise<{
  readonly activeToken: string
  readonly staleDelivery: ClaimedDelivery
}> {
  const activeToken = `afw_${randomBytes(32).toString("base64url")}`
  const revokedToken = `afw_${randomBytes(32).toString("base64url")}`
  const activeCredential = randomUUID()
  const revokedCredential = randomUUID()
  await sql.begin(async (transaction) => {
    await transaction`insert into workspaces (id, name) values ('workspace', 'Workspace')`
    await transaction`insert into principals (id, workspace_id, display_name, kind)
      values ('admin', 'workspace', 'Admin', 'human')`
    await transaction`insert into workspace_memberships (workspace_id, principal_id, role)
      values ('workspace', 'admin', 'owner')`
    for (const permission of ["work.read", "work.create", "work.update", "work.assign"]) {
      await transaction`insert into membership_permissions
        (workspace_id, principal_id, permission) values ('workspace', 'admin', ${permission})`
    }
    await transaction`insert into principal_credentials
      (id, workspace_id, principal_id, token_hash, expires_at, revoked_at)
      values
        (${activeCredential}, 'workspace', 'admin', ${createHash("sha256").update(activeToken).digest()},
          '2030-01-01T00:00:00.000Z', null),
        (${revokedCredential}, 'workspace', 'admin', ${createHash("sha256").update(revokedToken).digest()},
          '2030-01-01T00:00:00.000Z', now())`
  })
  return populateBackupRows(sql, activeToken)
}

async function populateBackupRows(
  sql: Sql,
  activeToken: string,
): Promise<{ readonly activeToken: string; readonly staleDelivery: ClaimedDelivery }> {
  await sql`insert into spaces (workspace_id, id, name, visibility) values
    ('workspace', 'public', 'Public', 'public'), ('workspace', 'private', 'Private', 'private')`
  await sql`insert into space_permissions (workspace_id, space_id, principal_id, permission)
    values ('workspace', 'private', 'admin', 'work.read')`
  await new OutboxRepository(sql).register({ workspaceId: "workspace", destinationId: "local" })
  await sql`insert into workspace_event_sequences values ('workspace', 5)`
  await sql`insert into work_items values
    ('item', 'workspace', 'Item', 'started', 'admin', 5, now(), now(), 'private')`
  await sql`insert into work_item_revisions
    select 'item', 'workspace', 'Item ' || value::text, 'started', 'admin', value,
      now(), now(), 'private' from generate_series(1, 5) value`
  await sql`insert into domain_events
    select 'event-' || value::text, 'workspace', value, 'work_item.updated', now(), 'admin',
      'item', value, array['title']::text[], 'private' from generate_series(1, 5) value`
  await sql`insert into work_item_idempotency values
    ('workspace', 'create-item', 'fingerprint', 'item', 'event-1')`
  const leaseOwner = randomUUID()
  await sql`update outbox_jobs set state = 'leased', lease_owner = ${leaseOwner},
    lease_generation = 7, lease_expires_at = now() + interval '1 hour', attempts = 1
    where sequence = 2`
  await sql`update outbox_jobs set state = 'leased', lease_owner = ${randomUUID()},
    lease_generation = 9, lease_expires_at = now() + interval '1 hour', attempts = 5,
    last_error = 'fifth attempt' where sequence = 3`
  await sql`update outbox_jobs set state = 'delivered', delivered_at = now(), attempts = 1
    where sequence = 4`
  await sql`update outbox_jobs set state = 'dead_letter', attempts = 5,
    last_error = 'terminal' where sequence = 5`
  await sql`insert into delivery_inbox
    select 'local', event_id, workspace_id, sequence, event_type, occurred_at, actor_id,
      subject_id, subject_revision, changed_fields, now(), space_id from outbox_events where sequence = 4`
  return {
    activeToken,
    staleDelivery: {
      jobId: await jobIdForSequence(sql, 2),
      eventId: "event-2",
      workspaceId: "workspace",
      spaceId: "private",
      destinationId: "local",
      sequence: 2,
      eventType: "work_item.updated",
      occurredAt: new Date(),
      actorId: "admin",
      subjectId: "item",
      subjectRevision: 2,
      changedFields: ["title"],
      leaseOwner,
      leaseGeneration: 7,
      attempts: 1,
    },
  }
}

export async function migrateBackupSchema004(sql: Sql): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "afw-schema-004-migrations-"))
  try {
    for (const migration of PROFILE_004.migrations) {
      await cp(
        resolve(process.cwd(), "migrations", migration.name),
        join(directory, basename(migration.name)),
      )
    }
    await migrateDatabase(sql, directory)
  } finally {
    await rm(directory, { recursive: true })
  }
}

export async function populateR4BackupState(sql: Sql): Promise<void> {
  const snapshotId = randomUUID()
  const committedImport = randomUUID()
  const validatedImport = randomUUID()
  const leaseOwner = randomUUID()
  await sql`insert into entity_outbox_destinations_v1
    (workspace_id, destination_id, sink, active, start_after_sequence)
    values ('workspace', 'entity-local', 'database-inbox', true, 5)`
  await sql`insert into entity_events_v1
    (id, workspace_id, sequence, event_type, subject_kind, subject_id, subject_revision,
      occurred_at, actor_id, data)
    values ('generic-recovery-event', 'workspace', 6, 'entity.updated', 'work_item', 'item', 5,
      now(), 'admin', '{"kind":"work_item","changedFields":[]}'::jsonb)`
  await sql`update entity_outbox_jobs_v1 set state = 'leased', attempts = 2,
    lease_owner = ${leaseOwner}, lease_expires_at = now() + interval '1 hour', lease_generation = 3
    where event_id = 'generic-recovery-event'`
  await sql`insert into generic_command_idempotency
    (workspace_id, idempotency_key, command_id, principal_id, action, route, fingerprint,
      event_id, subject_id, result_revision, result)
    values ('workspace', 'generic-command', 'generic-command-id', 'admin', 'work.update',
      '/work-items/item', ${"a".repeat(64)}, 'generic-recovery-event', 'item', 5,
      '{"id":"item"}'::jsonb)`
  await sql`insert into human_query_snapshots
    (id, workspace_id, principal_id, credential_id, query_hash, sort_hash, authority_hash,
      matched, expires_at)
    select ${snapshotId}, 'workspace', 'admin', id, ${"b".repeat(64)}, ${"c".repeat(64)},
      ${"d".repeat(64)}, 1, clock_timestamp() + interval '10 minutes'
    from principal_credentials where revoked_at is null limit 1`
  await sql`insert into human_query_snapshot_items
    (snapshot_id, ordinal, entity_id, source_revision) values (${snapshotId}, 1, 'item', 5)`
  await sql`insert into import_batches
    (import_id, workspace_id, principal_id, content_digest, byte_size, record_count, state,
      validation_expires_at, committed_at)
    values
      (${committedImport}, 'workspace', 'admin', ${"e".repeat(64)}, 10, 1, 'committed',
        now() + interval '10 minutes', now()),
      (${validatedImport}, 'workspace', 'admin', ${"f".repeat(64)}, 10, 1, 'validated',
        now() + interval '10 minutes', null)`
  await sql`insert into import_record_ids (import_id, external_id, entity_id, record_kind)
    values (${committedImport}, 'committed-item', 'item', 'work_item'),
      (${validatedImport}, 'validated-item', 'item', 'work_item')`
}

export async function waitForExportedSnapshot(admin: Sql, database: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const rows = await admin<{ readonly active: boolean }[]>`select exists (
      select 1 from pg_stat_activity where datname = ${database}
        and application_name = 'agent-first-workspace-backup' and backend_xmin is not null
        and query ilike 'copy (%'
    ) as active`
    if (rows[0]?.active === true) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new TypeError("exported snapshot was not observed")
}

export function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  return url.toString()
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`)
  return value
}

async function jobIdForSequence(sql: Sql, sequence: number): Promise<string> {
  const rows = await sql<{ readonly job_id: string }[]>`select job_id from outbox_jobs
    where sequence = ${sequence}`
  const id = rows[0]?.job_id
  if (id === undefined) throw new TypeError("fixture job is missing")
  return id
}
