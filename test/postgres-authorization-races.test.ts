import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, beforeEach, test } from "node:test"
import type { TransactionSql } from "postgres"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
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

type Fixture = {
  readonly credentialId: string
  readonly store: AuthorizedPostgresWorkItemStore
  readonly itemId: string
}

async function authorizedFixture(expiresAt = "2030-01-01T00:00:00.000Z"): Promise<Fixture> {
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "workspace-one",
    workspaceName: "Workspace One",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt,
  })
  const context = await authenticateToken(database.sql, issued.token)
  if (context === undefined) throw new Error("fixture authentication failed")
  const store = new AuthorizedPostgresWorkItemStore(database.sql, context, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => "2026-10-09T12:00:00.000Z",
  })
  const created = await store.create({
    workspaceId: workspaceId("workspace-one"),
    title: workItemTitle("Race item"),
    accountableOwnerId: humanPrincipalId("human-one"),
    actorId: actorId("human-one"),
    idempotencyKey: idempotencyKey("race-create"),
  })
  if (created.kind !== "created") throw new Error("fixture create failed")
  return { credentialId: issued.credentialId, store, itemId: created.item.id }
}

test("get observes read grant revocation committed while waiting for authority locks", async () => {
  const fixture = await authorizedFixture()

  const result = await raceAuthorityChange(
    () => fixture.store.get(workItemId(fixture.itemId)),
    async (transaction) => {
      await transaction`delete from membership_permissions
        where workspace_id = 'workspace-one' and principal_id = 'human-one'
          and permission = 'work.read'`
    },
  )

  assert.equal(result, undefined)
})

test("patch returns the same not-found result after update revocation for existing and absent IDs", async () => {
  const fixture = await authorizedFixture()

  const existing = await raceAuthorityChange(
    () =>
      fixture.store.patch({
        id: workItemId(fixture.itemId),
        actorId: actorId("human-one"),
        baseRevision: revision(1),
        state: "started",
      }),
    async (transaction) => {
      await transaction`delete from membership_permissions
        where workspace_id = 'workspace-one' and principal_id = 'human-one'
          and permission = 'work.update'`
    },
  )
  const absent = await fixture.store.patch({
    id: workItemId("absent"),
    actorId: actorId("human-one"),
    baseRevision: revision(1),
    state: "started",
  })

  assert.deepEqual(existing, { kind: "not_found", id: fixture.itemId })
  assert.deepEqual(absent, { kind: "not_found", id: "absent" })
})

test("list returns permission denied after grant revocation committed while blocked", async () => {
  const fixture = await authorizedFixture()

  await assert.rejects(
    raceAuthorityChange(
      () => fixture.store.list(workspaceId("workspace-one"), 100),
      async (transaction) => {
        await transaction`delete from membership_permissions
          where workspace_id = 'workspace-one' and principal_id = 'human-one'
            and permission = 'work.read'`
      },
    ),
    { name: "PermissionDeniedError" },
  )
})

test("get returns generic authentication failure after credential revocation while blocked", async () => {
  const fixture = await authorizedFixture()

  await assert.rejects(
    raceAuthorityChange(
      () => fixture.store.get(workItemId(fixture.itemId)),
      async (transaction) => {
        await transaction`update principal_credentials set revoked_at = clock_timestamp()
          where id = ${fixture.credentialId}`
      },
    ),
    { name: "AuthenticationRequiredError" },
  )
})

test("list returns generic authentication failure after credential revocation while blocked", async () => {
  const fixture = await authorizedFixture()

  await assert.rejects(
    raceAuthorityChange(
      () => fixture.store.list(workspaceId("workspace-one"), 100),
      async (transaction) => {
        await transaction`update principal_credentials set revoked_at = clock_timestamp()
          where id = ${fixture.credentialId}`
      },
    ),
    { name: "AuthenticationRequiredError" },
  )
})

test("list rejects a credential whose expiry passes while authority lock is blocked", async () => {
  const expiryRows = await database.sql<{ readonly expires_at: Date }[]>`
    select clock_timestamp() + interval '300 milliseconds' as expires_at`
  const expiresAt = expiryRows[0]?.expires_at.toISOString()
  if (expiresAt === undefined) throw new Error("missing database expiry")
  const fixture = await authorizedFixture(expiresAt)

  await assert.rejects(
    raceAuthorityChange(
      () => fixture.store.list(workspaceId("workspace-one"), 100),
      async (transaction) => {
        for (;;) {
          const rows = await transaction<{ readonly expired: boolean }[]>`
            select clock_timestamp() >= expires_at as expired
            from principal_credentials where id = ${fixture.credentialId}`
          if (rows[0]?.expired === true) return
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      },
    ),
    { name: "AuthenticationRequiredError" },
  )
})

async function raceAuthorityChange<T>(
  operation: () => Promise<T>,
  change: (transaction: TransactionSql) => Promise<void>,
): Promise<T> {
  const blocker = database.connect()
  let authorityLocked: (() => void) | undefined
  const locked = new Promise<void>((resolve) => {
    authorityLocked = resolve
  })
  let applyChange: (() => void) | undefined
  const proceed = new Promise<void>((resolve) => {
    applyChange = resolve
  })
  const blockingTransaction = blocker.begin(async (transaction) => {
    await transaction`select id from workspaces where id = 'workspace-one' for update`
    await transaction`select id from principals where id = 'human-one' for update`
    await transaction`select principal_id from workspace_memberships
      where workspace_id = 'workspace-one' and principal_id = 'human-one' for update`
    await transaction`select id from principal_credentials
      where workspace_id = 'workspace-one' and principal_id = 'human-one' for update`
    authorityLocked?.()
    await proceed
    await change(transaction)
  })
  await locked
  const result = operation().then(
    (value) => ({ kind: "value", value }) as const,
    (error: unknown) => ({ kind: "error", error }) as const,
  )
  await waitForAuthorizationLock()
  applyChange?.()
  await blockingTransaction
  await blocker.end()
  const outcome = await result
  if (outcome.kind === "error") throw outcome.error
  return outcome.value
}

async function waitForAuthorizationLock(): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = await database.sql<{ readonly waiting: boolean }[]>`
      select exists (
        select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%from workspaces w%'
      ) as waiting`
    if (rows[0]?.waiting === true) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("authorization operation did not block")
}
