import assert from "node:assert/strict"
import { test } from "node:test"
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
import { DEFAULT_STORE_LIMITS, InMemoryWorkItemStore } from "../src/work-items/in-memory-store.ts"

const dependencies = {
  newWorkItemId: () => workItemId("item"),
  newEventId: () => eventId("event"),
  now: () => "2026-01-02T03:04:05.000Z",
}
const owner = humanPrincipalId("owner")
const actor = actorId("actor")

function command(workspace: string, key: string, title: string) {
  return {
    workspaceId: workspaceId(workspace),
    title: workItemTitle(title),
    accountableOwnerId: owner,
    actorId: actor,
    idempotencyKey: idempotencyKey(key),
  }
}

test("idempotency scopes cannot collide across workspace and key delimiters", () => {
  // Given
  const ids = ["first", "second"]
  const store = new InMemoryWorkItemStore({
    ...dependencies,
    newWorkItemId: () => workItemId(ids.shift() ?? "fallback"),
  })

  // When
  const first = store.create(command("a:b", "c", "First"))
  const second = store.create(command("a", "b:c", "Second"))

  // Then
  assert.equal(first.kind, "created")
  assert.equal(second.kind, "created")
})

test("semantic no-op patch preserves item, clock, IDs, history, and events", () => {
  // Given
  let clockCalls = 0
  let eventIdCalls = 0
  const store = new InMemoryWorkItemStore({
    ...dependencies,
    now: () => {
      clockCalls += 1
      return "2026-01-02T03:04:05.000Z"
    },
    newEventId: () => {
      eventIdCalls += 1
      return eventId(`event-${eventIdCalls}`)
    },
  })
  const created = store.create(command("workspace", "key", "Title"))
  assert.notEqual(created.kind, "idempotency_conflict")
  assert.notEqual(created.kind, "capacity_exceeded")
  if (created.kind === "idempotency_conflict" || created.kind === "capacity_exceeded") return

  // When
  const result = store.patch({
    id: created.item.id,
    actorId: actor,
    baseRevision: revision(1),
    title: workItemTitle("Title"),
    state: "unstarted",
  })

  // Then
  assert.deepEqual(result, { kind: "unchanged", item: created.item })
  assert.equal(clockCalls, 1)
  assert.equal(eventIdCalls, 1)
  assert.equal(store.history(created.item.id).length, 1)
  assert.equal(store.events().length, 1)
})

test("capacity failure is truthful and occurs before mutation", () => {
  // Given
  let clockCalls = 0
  let itemIdCalls = 0
  let eventIdCalls = 0
  const store = new InMemoryWorkItemStore(
    {
      now: () => {
        clockCalls += 1
        return dependencies.now()
      },
      newWorkItemId: () => {
        itemIdCalls += 1
        return workItemId(`item-${itemIdCalls}`)
      },
      newEventId: () => {
        eventIdCalls += 1
        return eventId(`event-${eventIdCalls}`)
      },
    },
    {
      itemCapacity: 1,
      auditRecordCapacity: 10,
    },
  )
  store.create(command("workspace", "first", "First"))
  const callsBeforeFailure = { clockCalls, itemIdCalls, eventIdCalls }

  // When
  const result = store.create(command("workspace", "second", "Second"))

  // Then
  assert.deepEqual(DEFAULT_STORE_LIMITS, {
    itemCapacity: 10_000,
    auditRecordCapacity: 100_000,
  })
  assert.deepEqual(result, { kind: "capacity_exceeded", resource: "items", capacity: 1 })
  assert.deepEqual({ clockCalls, itemIdCalls, eventIdCalls }, callsBeforeFailure)
  assert.equal(store.list(workspaceId("workspace"), 100).matched, 1)
  assert.equal(store.events().length, 1)
})

test("store list returns at most the requested limit and the full matched count", () => {
  // Given
  let nextId = 0
  const store = new InMemoryWorkItemStore({
    ...dependencies,
    newWorkItemId: () => {
      nextId += 1
      return workItemId(`item-${nextId}`)
    },
    newEventId: () => eventId(`event-${nextId}`),
  })
  for (let index = 0; index < 101; index += 1) {
    store.create(command("workspace", `key-${index}`, `Item ${index}`))
  }

  // When
  const result = store.list(workspaceId("workspace"), 100)

  // Then
  assert.equal(result.items.length, 100)
  assert.equal(result.matched, 101)
})
