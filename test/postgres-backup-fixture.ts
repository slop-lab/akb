import { randomBytes, randomUUID } from "node:crypto"
import type { Sql } from "postgres"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { OutboxRepository, type ClaimedDelivery } from "../src/outbox/repository.ts"

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
    activeToken: active.token,
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
