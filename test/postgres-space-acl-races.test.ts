import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, beforeEach, test } from "node:test"
import type { TransactionSql } from "postgres"
import { PostgresWorkspaceEventReader } from "../src/events/postgres-reader.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { AuthorizedPostgresWorkItemStore } from "../src/work-items/authorized-postgres-store.ts"
import {
  actorId,
  eventId,
  humanPrincipalId,
  idempotencyKey,
  revision,
  spaceId,
  workItemId,
  workItemTitle,
  workspaceId,
} from "../src/work-items/identifiers.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
const identity = new IdentityAdmin(database.sql)
const spaces = new SpaceAdmin(database.sql)
after(database.close)
beforeEach(database.reset)

async function fixture(visibility: "public" | "private" = "private") {
  const issued = await identity.bootstrapWorkspace({
    workspaceId: "workspace",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await spaces.create({
    workspaceId: "workspace",
    spaceId: "space",
    spaceName: "Space",
    visibility,
  })
  if (visibility === "private") {
    await spaces.setPermissions({
      workspaceId: "workspace",
      spaceId: "space",
      principalId: "owner",
      permissions: ["work.read", "work.create", "work.update", "work.assign"],
    })
  }
  const context = await authenticateToken(database.sql, issued.token)
  if (context === undefined) throw new Error("fixture authentication failed")
  const store = new AuthorizedPostgresWorkItemStore(database.sql, context, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => "2026-10-09T12:00:00.000Z",
  })
  return { context, store }
}

function command(key: string) {
  return {
    workspaceId: workspaceId("workspace"),
    spaceId: spaceId("space"),
    title: workItemTitle(key),
    accountableOwnerId: humanPrincipalId("owner"),
    actorId: actorId("owner"),
    idempotencyKey: idempotencyKey(key),
  }
}

async function racePolicyChange<T>(
  action: () => Promise<T>,
  change: (transaction: TransactionSql) => Promise<void>,
): Promise<T> {
  const admin = database.connect()
  let releasePolicy: (() => void) | undefined
  const release = new Promise<void>((resolve) => {
    releasePolicy = resolve
  })
  let reportLocked: (() => void) | undefined
  const locked = new Promise<void>((resolve) => {
    reportLocked = resolve
  })
  const policyChange = admin.begin(async (transaction) => {
    await transaction`select id from workspaces where id = 'workspace' for update`
    reportLocked?.()
    await release
    await change(transaction)
  })
  await locked
  const operation = action()
  await new Promise<void>((resolve) => setImmediate(resolve))
  releasePolicy?.()
  await policyChange
  try {
    return await operation
  } finally {
    await admin.end()
  }
}

test("create observes a public-to-private visibility change committed while blocked", async () => {
  // Given
  const target = await fixture("public")

  // When / Then
  await assert.rejects(
    racePolicyChange(
      () => target.store.create(command("create")),
      async (transaction) => {
        await transaction`update spaces set visibility = 'private'
          where workspace_id = 'workspace' and id = 'space'`
      },
    ),
    { name: "SpaceNotFoundError" },
  )
})

test("get observes private read revocation committed while blocked", async () => {
  const target = await fixture()
  const created = await target.store.create(command("get"))
  if (created.kind !== "created") throw new Error("fixture create failed")

  const result = await revokeWhileBlocked(() => target.store.get(created.item.id), "work.read")

  assert.equal(result, undefined)
})

test("patch observes private update revocation committed while blocked", async () => {
  const target = await fixture()
  const created = await target.store.create(command("patch"))
  if (created.kind !== "created") throw new Error("fixture create failed")

  const result = await revokeWhileBlocked(
    () =>
      target.store.patch({
        id: created.item.id,
        actorId: actorId("owner"),
        baseRevision: revision(1),
        state: "started",
      }),
    "work.update",
  )

  assert.equal(result.kind, "not_found")
})

test("list observes private read revocation committed while blocked", async () => {
  const target = await fixture()
  await target.store.create(command("list"))

  const result = await revokeWhileBlocked(
    () => target.store.list(workspaceId("workspace"), 100),
    "work.read",
  )

  assert.equal(result.matched, 0)
})

test("replay observes private read revocation committed while blocked", async () => {
  const target = await fixture()
  await target.store.create(command("replay"))
  const reader = new PostgresWorkspaceEventReader(database.sql, target.context)

  await assert.rejects(
    revokeWhileBlocked(() => reader.read("workspace", 0, 100), "work.read"),
    { name: "PermissionDeniedError" },
  )
})

function revokeWhileBlocked<T>(action: () => Promise<T>, permission: string): Promise<T> {
  return racePolicyChange(action, async (transaction) => {
    await transaction`delete from space_permissions where workspace_id = 'workspace'
      and space_id = 'space' and principal_id = 'owner' and permission = ${permission}`
  })
}
