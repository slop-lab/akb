import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, beforeEach, test } from "node:test"
import type { Sql } from "postgres"
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
import { PostgresWorkItemStore } from "../src/work-items/postgres-store.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
const sql = database.sql
const workspace = workspaceId("postgres-workspace")
const otherWorkspace = workspaceId("other-workspace")
const owner = humanPrincipalId("human-1")
const actor = actorId("actor-1")

beforeEach(database.reset)
after(database.close)

function createStore(client: Sql = sql): PostgresWorkItemStore {
  return new PostgresWorkItemStore(client, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => new Date().toISOString(),
  })
}

function createCommand(key: string, targetWorkspace = workspace) {
  return {
    workspaceId: targetWorkspace,
    title: workItemTitle("Persisted item"),
    accountableOwnerId: owner,
    actorId: actor,
    idempotencyKey: idempotencyKey(key),
  } as const
}

test("PostgreSQL preserves current state and history across store restart", async () => {
  // Given
  const firstClient = database.connect()
  const created = await createStore(firstClient).create(createCommand("restart"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  await firstClient.end()

  // When
  const restartedClient = database.connect()
  const restartedStore = createStore(restartedClient)
  const current = await restartedStore.get(created.item.id)
  const history = await restartedStore.history(created.item.id)
  await restartedClient.end()

  // Then
  assert.deepEqual(current, created.item)
  assert.deepEqual(history, [created.item])
})

test("create replay returns its original item after patch and reconnect", async () => {
  // Given
  const command = createCommand("replay-after-patch")
  const firstClient = database.connect()
  const firstStore = createStore(firstClient)
  const created = await firstStore.create(command)
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const patched = await firstStore.patch({
    id: created.item.id,
    actorId: actor,
    baseRevision: revision(1),
    title: workItemTitle("Patched item"),
    state: "started",
  })
  assert.equal(patched.kind, "updated")
  await firstClient.end()
  const restartedClient = database.connect()
  const restartedStore = createStore(restartedClient)

  // When
  const replayed = await restartedStore.create(command)
  await restartedClient.end()

  // Then
  assert.equal(replayed.kind, "replayed")
  if (replayed.kind !== "replayed") return
  assert.deepEqual(replayed.item, created.item)
  assert.equal(replayed.eventId, created.eventId)
})

test("patched create rejects a conflicting replay after reconnect", async () => {
  // Given
  const command = createCommand("conflict-after-patch")
  const firstClient = database.connect()
  const firstStore = createStore(firstClient)
  const created = await firstStore.create(command)
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  assert.equal(
    (
      await firstStore.patch({
        id: created.item.id,
        actorId: actor,
        baseRevision: revision(1),
        title: workItemTitle("Patched item"),
      })
    ).kind,
    "updated",
  )
  await firstClient.end()
  const restartedClient = database.connect()
  const restartedStore = createStore(restartedClient)

  // When
  const conflict = await restartedStore.create({
    ...command,
    title: workItemTitle("Conflicting command"),
  })
  await restartedClient.end()

  // Then
  assert.deepEqual(conflict, {
    kind: "idempotency_conflict",
    idempotencyKey: command.idempotencyKey,
  })
})

test("simultaneous same-base PostgreSQL patches have one winner", async () => {
  // Given
  const store = createStore()
  const created = await store.create(createCommand("patch-race"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  // When
  const results = await Promise.all([
    store.patch({
      id: created.item.id,
      actorId: actor,
      baseRevision: revision(1),
      title: workItemTitle("First"),
    }),
    store.patch({
      id: created.item.id,
      actorId: actor,
      baseRevision: revision(1),
      title: workItemTitle("Second"),
    }),
  ])

  // Then
  assert.deepEqual(results.map((result) => result.kind).sort(), ["revision_conflict", "updated"])
  assert.equal((await store.history(created.item.id)).length, 2)
  assert.equal((await store.events()).length, 2)
})

test("concurrent duplicate creates safely replay one durable result", async () => {
  // Given
  const store = createStore()
  const command = createCommand("duplicate-race")

  // When
  const results = await Promise.all([store.create(command), store.create(command)])

  // Then
  assert.deepEqual(results.map((result) => result.kind).sort(), ["created", "replayed"])
  const successful = results.filter(
    (result) => result.kind === "created" || result.kind === "replayed",
  )
  assert.equal(successful[0]?.item.id, successful[1]?.item.id)
  assert.equal(successful[0]?.eventId, successful[1]?.eventId)
  assert.equal((await store.events()).length, 1)
})

test("failed patch restores current, history, event, and workspace sequence", async () => {
  // Given
  const duplicateEvent = eventId("duplicate-patch-event")
  const store = new PostgresWorkItemStore(sql, {
    newWorkItemId: () => workItemId("patch-rollback-item"),
    newEventId: () => duplicateEvent,
    now: () => "2026-10-09T12:00:00.000Z",
  })
  const created = await store.create(createCommand("patch-rollback"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return

  // When
  await assert.rejects(
    store.patch({
      id: created.item.id,
      actorId: actor,
      baseRevision: revision(1),
      title: workItemTitle("Must roll back"),
    }),
  )

  // Then
  assert.deepEqual(await store.get(created.item.id), created.item)
  assert.deepEqual(await store.history(created.item.id), [created.item])
  assert.deepEqual(
    (await store.events()).map((event) => event.id),
    [duplicateEvent],
  )
  const sequenceRows = await sql<{ readonly last_sequence: string }[]>`
    select last_sequence from workspace_event_sequences where workspace_id = ${workspace}
  `
  assert.deepEqual(
    sequenceRows.map((row) => row.last_sequence),
    ["1"],
  )
})

test("event insertion failure rolls back current, history, event, and idempotency", async () => {
  // Given
  const duplicateEvent = eventId("duplicate-event")
  const itemIds = [workItemId("first-item"), workItemId("rolled-back-item")]
  const store = new PostgresWorkItemStore(sql, {
    newWorkItemId: () => itemIds.shift() ?? workItemId("unexpected-item"),
    newEventId: () => duplicateEvent,
    now: () => "2026-10-09T12:00:00.000Z",
  })
  assert.equal((await store.create(createCommand("first"))).kind, "created")

  // When
  await assert.rejects(store.create(createCommand("rollback")))

  // Then
  assert.equal(await store.get(workItemId("rolled-back-item")), undefined)
  assert.equal((await store.history(workItemId("rolled-back-item"))).length, 0)
  assert.equal((await store.events()).length, 1)
  const records = await sql<{ readonly idempotency_key: string }[]>`
    select idempotency_key from work_item_idempotency order by idempotency_key
  `
  assert.deepEqual(
    records.map((row) => row.idempotency_key),
    ["first"],
  )
})

test("PostgreSQL list is workspace-scoped with truthful matched count", async () => {
  // Given
  const store = createStore()
  await store.create(createCommand("one"))
  await store.create(createCommand("two"))
  await store.create(createCommand("other", otherWorkspace))

  // When
  const result = await store.list(workspace, 1)

  // Then
  assert.equal(result.items.length, 1)
  assert.equal(result.matched, 2)
  assert.equal(result.items[0]?.workspaceId, workspace)
})
