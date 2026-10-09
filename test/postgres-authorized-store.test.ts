import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import {
  PermissionDeniedError,
  WorkspaceNotFoundError,
} from "../src/identity/authorization-errors.ts"
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
import { AuthorizedPostgresWorkItemStore } from "../src/work-items/authorized-postgres-store.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
const admin = new IdentityAdmin(database.sql)
after(database.close)
beforeEach(database.reset)

async function ownerStore() {
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "workspace-one",
    workspaceName: "One",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const context = await authenticateToken(database.sql, issued.token)
  if (context === undefined) throw new Error("fixture authentication failed")
  return {
    issued,
    store: new AuthorizedPostgresWorkItemStore(database.sql, context, {
      newWorkItemId: () => workItemId(randomUUID()),
      newEventId: () => eventId(randomUUID()),
      now: () => "2026-10-09T12:00:00.000Z",
    }),
  }
}

function command(actor = "human-one") {
  return {
    workspaceId: workspaceId("workspace-one"),
    title: workItemTitle("Authorized item"),
    accountableOwnerId: humanPrincipalId("human-one"),
    actorId: actorId(actor),
    idempotencyKey: idempotencyKey("create-one"),
  }
}

test("authorized create, get, list, and patch persist the authenticated actor", async () => {
  const { store } = await ownerStore()
  const created = await store.create(command())
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  const patched = await store.patch({
    id: created.item.id,
    actorId: actorId("human-one"),
    baseRevision: revision(1),
    state: "started",
  })
  const read = await store.get(created.item.id)
  const listed = await store.list(workspaceId("workspace-one"), 100)
  const events = await database.sql<
    { readonly actor_id: string }[]
  >`select actor_id from domain_events order by sequence`

  assert.equal(patched.kind, "updated")
  assert.equal(read?.state, "started")
  assert.equal(listed.matched, 1)
  assert.deepEqual(
    events.map((event) => event.actor_id),
    ["human-one", "human-one"],
  )
})

test("forged actor, invalid owner, missing grants, and cross-workspace paths mutate nothing", async () => {
  const { store } = await ownerStore()
  await assert.rejects(store.create(command("forged")), PermissionDeniedError)
  await assert.rejects(
    store.create({ ...command(), accountableOwnerId: humanPrincipalId("missing") }),
    PermissionDeniedError,
  )
  await assert.rejects(store.list(workspaceId("other"), 100), WorkspaceNotFoundError)
  await admin.setPermissions({
    workspaceId: "workspace-one",
    principalId: "human-one",
    permissions: [],
  })
  await assert.rejects(store.create(command()), PermissionDeniedError)
  const counts = await database.sql<
    { readonly count: number }[]
  >`select count(*)::integer as count from work_items`
  assert.equal(counts[0]?.count, 0)
})

test("cross-workspace item reads and patches are indistinguishable from absent items", async () => {
  const { store } = await ownerStore()
  await database.sql`insert into work_items
    (id, workspace_id, title, state, accountable_owner_id, revision, created_at, updated_at)
    values ('hidden', 'other', 'Hidden', 'unstarted', 'other-owner', 1, now(), now())`

  assert.equal(await store.get(workItemId("hidden")), undefined)
  assert.deepEqual(
    await store.patch({
      id: workItemId("hidden"),
      actorId: actorId("human-one"),
      baseRevision: revision(1),
      state: "started",
    }),
    { kind: "not_found", id: "hidden" },
  )
})

test("credential revocation is revalidated inside later store transactions", async () => {
  const { issued, store } = await ownerStore()
  await admin.revokeToken({ credentialId: issued.credentialId })
  await assert.rejects(store.create(command()), { name: "AuthenticationRequiredError" })
})

test("concurrent revocation holding authorization locks makes a blocked mutation fail atomically", async () => {
  const { issued, store } = await ownerStore()
  const revoker = database.connect()
  let releaseRevocation: (() => void) | undefined
  const release = new Promise<void>((resolve) => {
    releaseRevocation = resolve
  })
  let locked: (() => void) | undefined
  const hasLocked = new Promise<void>((resolve) => {
    locked = resolve
  })
  const revocation = revoker.begin(async (transaction) => {
    await transaction`select id from workspaces where id = 'workspace-one' for update`
    await transaction`select id from principals where id = 'human-one' for update`
    await transaction`select principal_id from workspace_memberships
      where workspace_id = 'workspace-one' and principal_id = 'human-one' for update`
    await transaction`select id from principal_credentials where id = ${issued.credentialId} for update`
    locked?.()
    await release
    await transaction`update principal_credentials set revoked_at = now()
      where id = ${issued.credentialId}`
  })
  await hasLocked
  const mutation = store.create(command())
  let observedBlockedMutation = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await database.sql<{ readonly waiting: boolean }[]>`
      select exists (
        select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%from workspaces w%'
      ) as waiting`
    if (waiting[0]?.waiting === true) {
      observedBlockedMutation = true
      break
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.equal(observedBlockedMutation, true)
  releaseRevocation?.()
  await revocation
  await assert.rejects(mutation, { name: "AuthenticationRequiredError" })
  const counts = await database.sql<{ readonly count: number }[]>`
    select count(*)::integer as count from work_items`
  assert.equal(counts[0]?.count, 0)
  await revoker.end()
})
