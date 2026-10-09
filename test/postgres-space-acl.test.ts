import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { PostgresWorkspaceEventReader } from "../src/events/postgres-reader.ts"
import { OutboxRepository } from "../src/outbox/repository.ts"
import { runDatabaseInboxWorker } from "../src/outbox/worker.ts"
import { AuthorizedPostgresWorkItemStore } from "../src/work-items/authorized-postgres-store.ts"
import {
  actorId,
  eventId,
  humanPrincipalId,
  idempotencyKey,
  spaceId,
  workItemId,
  workItemTitle,
  workspaceId,
} from "../src/work-items/identifiers.ts"
import type { AuthenticatedPrincipal, WorkPermission } from "../src/identity/types.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
const identity = new IdentityAdmin(database.sql)
const spaces = new SpaceAdmin(database.sql)
after(database.close)
beforeEach(database.reset)

async function bootstrap() {
  const issued = await identity.bootstrapWorkspace({
    workspaceId: "workspace",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(database.sql, issued.token)
  if (principal === undefined) throw new Error("fixture authentication failed")
  return { issued, principal }
}

async function principal(
  id: string,
  permissions: readonly WorkPermission[],
): Promise<AuthenticatedPrincipal> {
  await identity.provisionPrincipal({
    workspaceId: "workspace",
    principalId: id,
    displayName: id,
    kind: "human",
    role: "admin",
    permissions: [...permissions],
  })
  const issued = await identity.issueToken({
    workspaceId: "workspace",
    principalId: id,
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const authenticated = await authenticateToken(database.sql, issued.token)
  if (authenticated === undefined) throw new Error("fixture authentication failed")
  return authenticated
}

function store(context: AuthenticatedPrincipal) {
  return new AuthorizedPostgresWorkItemStore(database.sql, context, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => "2026-10-09T12:00:00.000Z",
  })
}

function command(key: string, owner: string, scope?: string) {
  return {
    workspaceId: workspaceId("workspace"),
    title: workItemTitle(key),
    accountableOwnerId: humanPrincipalId(owner),
    actorId: actorId("owner"),
    idempotencyKey: idempotencyKey(key),
    ...(scope === undefined ? {} : { spaceId: spaceId(scope) }),
  }
}

test("private Space requires baseline and matching grants without owner or admin override", async () => {
  // Given
  const owner = await bootstrap()
  await spaces.create({
    workspaceId: "workspace",
    spaceId: "public",
    spaceName: "Public",
    visibility: "public",
  })
  await spaces.create({
    workspaceId: "workspace",
    spaceId: "private",
    spaceName: "Private",
    visibility: "private",
  })
  const ownerStore = store(owner.principal)

  // When
  const legacy = await ownerStore.create(command("legacy", "owner"))
  const publicItem = await ownerStore.create(command("public", "owner", "public"))
  await assert.rejects(ownerStore.create(command("denied", "owner", "private")), {
    name: "SpaceNotFoundError",
  })
  await spaces.setPermissions({
    workspaceId: "workspace",
    spaceId: "private",
    principalId: "owner",
    permissions: ["work.read", "work.create", "work.update", "work.assign"],
  })
  const privateItem = await ownerStore.create(command("private", "owner", "private"))
  const admin = await principal("admin", ["work.read", "work.create", "work.update", "work.assign"])
  const adminStore = store(admin)

  // Then
  assert.equal(legacy.kind, "created")
  assert.equal(publicItem.kind, "created")
  assert.equal(privateItem.kind, "created")
  if (privateItem.kind !== "created") return
  assert.equal(await adminStore.get(privateItem.item.id), undefined)
  assert.equal((await adminStore.list(workspaceId("workspace"), 100)).matched, 2)
  await spaces.setPermissions({
    workspaceId: "workspace",
    spaceId: "private",
    principalId: "admin",
    permissions: ["work.read"],
  })
  assert.equal((await adminStore.get(privateItem.item.id))?.spaceId, "private")
  await spaces.setPermissions({
    workspaceId: "workspace",
    spaceId: "private",
    principalId: "admin",
    permissions: [],
  })
  assert.equal(await adminStore.get(privateItem.item.id), undefined)
})

test("private rows before a visible row do not consume list limit or count", async () => {
  // Given
  const owner = await bootstrap()
  await spaces.create({
    workspaceId: "workspace",
    spaceId: "hidden",
    spaceName: "Hidden",
    visibility: "private",
  })
  const viewer = await principal("viewer", ["work.read"])
  await database.sql`insert into work_items
    (id, workspace_id, space_id, title, state, accountable_owner_id, revision, created_at, updated_at)
    select 'hidden-' || value, 'workspace', 'hidden', 'Hidden', 'unstarted', 'owner', 1,
      '2026-01-01'::timestamptz + value * interval '1 second', '2026-01-01'::timestamptz
    from generate_series(1, 100) value`
  const visible = await store(owner.principal).create(command("visible", "owner"))

  // When
  const result = await store(viewer).list(workspaceId("workspace"), 100)

  // Then
  assert.equal(visible.kind, "created")
  assert.equal(result.matched, 1)
  assert.equal(result.items[0]?.title, "visible")
})

test("workspace replay fails closed until every private Space is readable", async () => {
  // Given
  const owner = await bootstrap()
  await spaces.create({
    workspaceId: "workspace",
    spaceId: "private",
    spaceName: "Private",
    visibility: "private",
  })
  const viewer = await principal("viewer", ["work.read"])
  await store(owner.principal).create(command("legacy", "owner"))
  const reader = new PostgresWorkspaceEventReader(database.sql, viewer)

  // When / Then
  await assert.rejects(reader.read("workspace", 0, 100), { name: "PermissionDeniedError" })
  await spaces.setPermissions({
    workspaceId: "workspace",
    spaceId: "private",
    principalId: "viewer",
    permissions: ["work.read"],
  })
  assert.deepEqual(
    (await reader.read("workspace", 0, 100)).events.map((event) => event.sequence),
    [1],
  )
})

test("scope propagates through history, events, outbox, and inbox and remains immutable", async () => {
  // Given
  const owner = await bootstrap()
  await spaces.create({
    workspaceId: "workspace",
    spaceId: "private",
    spaceName: "Private",
    visibility: "private",
  })
  await spaces.setPermissions({
    workspaceId: "workspace",
    spaceId: "private",
    principalId: "owner",
    permissions: ["work.read", "work.create", "work.update", "work.assign"],
  })
  const repository = new OutboxRepository(database.sql)
  await repository.register({ workspaceId: "workspace", destinationId: "inbox" })

  // When
  const created = await store(owner.principal).create(command("scoped", "owner", "private"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  await runDatabaseInboxWorker(
    repository,
    { workspaceId: "workspace", destinationId: "inbox" },
    { drain: true },
  )

  // Then
  const rows = await database.sql<{ readonly source: string; readonly space_id: string | null }[]>`
    select 'revision' as source, space_id from work_item_revisions union all
    select 'event', space_id from domain_events union all
    select 'outbox', space_id from outbox_events union all
    select 'inbox', space_id from delivery_inbox order by source`
  assert.deepEqual(
    rows.map((row) => row.space_id),
    ["private", "private", "private", "private"],
  )
  await assert.rejects(
    database.sql`update work_items set space_id = null where id = ${created.item.id}`,
    /scope is immutable/,
  )
  await assert.rejects(
    database.sql`insert into work_items
    (id, workspace_id, space_id, title, state, accountable_owner_id, revision, created_at, updated_at)
    values ('cross', 'workspace', 'missing', 'Cross', 'unstarted', 'owner', 1, now(), now())`,
    /foreign key/,
  )
})

test("idempotent retry requires current baseline and private read authority", async () => {
  // Given
  const owner = await bootstrap()
  await spaces.create({
    workspaceId: "workspace",
    spaceId: "private",
    spaceName: "Private",
    visibility: "private",
  })
  const all = ["work.read", "work.create", "work.update", "work.assign"] as const
  await spaces.setPermissions({
    workspaceId: "workspace",
    spaceId: "private",
    principalId: "owner",
    permissions: [...all],
  })
  const ownerStore = store(owner.principal)
  const created = await ownerStore.create(command("same", "owner", "private"))
  assert.equal(created.kind, "created")
  await spaces.setPermissions({
    workspaceId: "workspace",
    spaceId: "private",
    principalId: "owner",
    permissions: ["work.create", "work.assign"],
  })

  // When / Then
  await assert.rejects(ownerStore.create(command("same", "owner", "private")), {
    name: "PermissionDeniedError",
  })
})
