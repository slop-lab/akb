import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { AuthorizedPostgresWorkItemStore } from "../src/work-items/authorized-postgres-store.ts"
import {
  actorId,
  eventId,
  humanPrincipalId,
  idempotencyKey,
  revision,
  workItemId,
  workItemTitle,
  workspaceId,
} from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
})

afterEach(async () => {
  await fixture.close()
})

test("schema 004 upgrades without widening grants or inventing legacy actors", async () => {
  // Given
  const legacy = await copyLegacyMigrations()
  await migrateDatabase(fixture.sql, legacy)
  await fixture.sql`insert into workspaces (id, name) values ('w1', 'One'), ('w2', 'Two')`
  await fixture.sql`insert into principals (id, workspace_id, display_name, kind)
    values ('owner', 'w1', 'Owner', 'human')`
  await fixture.sql`insert into workspace_memberships (workspace_id, principal_id, role)
    values ('w1', 'owner', 'owner')`
  await fixture.sql`insert into membership_permissions (workspace_id, principal_id, permission)
    values ('w1', 'owner', 'work.read')`
  await fixture.sql`insert into spaces (workspace_id, id, name, visibility)
    values ('w1', 'same', 'One', 'public'), ('w2', 'same', 'Two', 'public')`
  await fixture.sql`insert into work_items
    (id, workspace_id, space_id, title, state, accountable_owner_id, revision, created_at, updated_at)
    values ('item-1', 'w1', 'same', 'Legacy', 'unstarted', 'owner', 1, now(), now())`
  await fixture.sql`insert into work_item_revisions
    (work_item_id, workspace_id, space_id, title, state, accountable_owner_id, revision, created_at, updated_at)
    select id, workspace_id, space_id, title, state, accountable_owner_id, revision, created_at, updated_at
    from work_items`
  await fixture.sql`insert into workspace_event_sequences values ('w1', 1)`
  await fixture.sql`insert into domain_events
    (id, workspace_id, space_id, sequence, event_type, occurred_at, actor_id, subject_id, subject_revision, changed_fields)
    values ('event-1', 'w1', 'same', 1, 'work_item.created', now(), 'missing', 'item-1', 1, null)`

  // When
  await migrateDatabase(fixture.sql)

  // Then
  const grants = await fixture.sql`select permission from membership_permissions`
  assert.deepEqual([...grants], [{ permission: "work.read" }])
  const spaces = await fixture.sql<{ readonly id: string }[]>`
    select id from entities where kind = 'space' order by id`
  assert.equal(new Set(spaces.map((row) => row.id)).size, 2)
  const revision = await fixture.sql`select actor_id, canonical_snapshot->>'spaceId' as space_id
    from entity_revisions where entity_id = 'item-1'`
  assert.deepEqual([...revision], [{ actor_id: null, space_id: "same" }])
  const jobs = await fixture.sql`select count(*)::integer as count from entity_outbox_jobs_v1`
  assert.deepEqual([...jobs], [{ count: 0 }])
  await rm(legacy, { recursive: true })
})

test("legacy Work Item events atomically mirror registry revision and generic outbox", async () => {
  // Given
  await migrateDatabase(fixture.sql)
  await fixture.sql`insert into workspaces (id, name) values ('w', 'Workspace')`
  await fixture.sql`insert into principals (id, workspace_id, display_name, kind)
    values ('owner', 'w', 'Owner', 'human')`
  await fixture.sql`insert into workspace_memberships values ('w', 'owner', 'owner', 'active', now(), now())`
  await fixture.sql`insert into membership_permissions values ('w', 'owner', 'work.read', now())`
  await fixture.sql`insert into entity_outbox_destinations_v1
    (workspace_id, destination_id, sink, start_after_sequence) values ('w', 'sink', 'database-inbox', 0)`
  await fixture.sql`insert into work_items
    (id, workspace_id, title, state, accountable_owner_id, revision, created_at, updated_at)
    values ('item', 'w', 'Created', 'unstarted', 'owner', 1, now(), now())`
  await fixture.sql`insert into work_item_revisions
    (work_item_id, workspace_id, title, state, accountable_owner_id, revision, created_at, updated_at)
    select id, workspace_id, title, state, accountable_owner_id, revision, created_at, updated_at
    from work_items`
  await fixture.sql`insert into workspace_event_sequences values ('w', 1)`

  // When
  await fixture.sql`insert into domain_events
    (id, workspace_id, sequence, event_type, occurred_at, actor_id, subject_id, subject_revision, changed_fields)
    values ('event', 'w', 1, 'work_item.created', now(), 'owner', 'item', 1, null)`

  // Then
  const counts = await fixture.sql`select
    (select count(*)::integer from entities where id = 'item') as entities,
    (select count(*)::integer from entity_revisions where entity_id = 'item') as revisions,
    (select count(*)::integer from entity_events_v1 where id = 'event') as events,
    (select count(*)::integer from entity_outbox_jobs_v1 where event_id = 'event') as jobs`
  assert.deepEqual([...counts], [{ entities: 1, revisions: 1, events: 1, jobs: 1 }])
})

test("restricted entity ACL narrows legacy Work Item reads lists and patches", async () => {
  // Given
  await migrateDatabase(fixture.sql)
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(fixture.sql, issued.token)
  if (principal === undefined) throw new Error("missing authenticated fixture principal")
  const store = new AuthorizedPostgresWorkItemStore(fixture.sql, principal, {
    newWorkItemId: () => workItemId("item"),
    newEventId: () => eventId("event"),
    now: () => "2026-01-02T03:04:05.000Z",
  })
  const created = await store.create({
    workspaceId: workspaceId("w"),
    title: workItemTitle("Restricted"),
    accountableOwnerId: humanPrincipalId("owner"),
    actorId: actorId("owner"),
    idempotencyKey: idempotencyKey("create"),
  })
  assert.equal(created.kind, "created")
  await fixture.sql`update entity_acl_policies set mode = 'restricted' where entity_id = 'item'`

  // When
  const item = await store.get(workItemId("item"))
  const list = await store.list(workspaceId("w"), 100)
  const patch = await store.patch({
    id: workItemId("item"),
    actorId: actorId("owner"),
    baseRevision: revision(1),
    title: workItemTitle("Denied"),
  })

  // Then
  assert.equal(item, undefined)
  assert.deepEqual(list, { items: [], matched: 0 })
  assert.equal(patch.kind, "not_found")
  const epoch = await fixture.sql<{ readonly epoch: string }[]>`
    select epoch::text from workspace_authority_epochs where workspace_id = 'w'`
  assert.equal(Number(epoch[0]?.epoch) > 1, true)
})

async function copyLegacyMigrations(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "afw-schema-004-"))
  for (const name of [
    "001_work_item_persistence.sql",
    "002_workspace_identity.sql",
    "003_transactional_outbox.sql",
    "004_space_acl.sql",
  ]) {
    await writeFile(join(directory, name), await readFile(join(process.cwd(), "migrations", name)))
  }
  return directory
}
