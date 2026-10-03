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
import { InMemoryWorkItemStore } from "../src/work-items/in-memory-store.ts"

const workspace = workspaceId("audit-workspace")
const owner = humanPrincipalId("audit-owner")
const actor = actorId("audit-actor")

type Calls = { clock: number; itemId: number; eventId: number }

function fixture(itemCapacity: number, auditRecordCapacity: number) {
  const calls: Calls = { clock: 0, itemId: 0, eventId: 0 }
  const store = new InMemoryWorkItemStore(
    {
      now: () => {
        calls.clock += 1
        return `2026-01-02T03:04:0${calls.clock}.000Z`
      },
      newWorkItemId: () => {
        calls.itemId += 1
        return workItemId(`audit-item-${calls.itemId}`)
      },
      newEventId: () => {
        calls.eventId += 1
        return eventId(`audit-event-${calls.eventId}`)
      },
    },
    { itemCapacity, auditRecordCapacity },
  )
  return { store, calls }
}

function command(key: string, title: string) {
  return {
    workspaceId: workspace,
    title: workItemTitle(title),
    accountableOwnerId: owner,
    actorId: actor,
    idempotencyKey: idempotencyKey(key),
  }
}

test("create rejects an exhausted audit budget before generators or mutation", () => {
  // Given
  const { store, calls } = fixture(2, 1)
  const first = store.create(command("first", "First"))
  assert.equal(first.kind, "created")
  if (first.kind !== "created") return
  const before = {
    calls: { ...calls },
    item: store.get(first.item.id),
    history: store.history(first.item.id),
    events: store.events(),
  }

  // When
  const result = store.create(command("second", "Second"))

  // Then
  assert.deepEqual(result, {
    kind: "capacity_exceeded",
    resource: "audit_records",
    capacity: 1,
  })
  assert.deepEqual(calls, before.calls)
  assert.deepEqual(store.get(first.item.id), before.item)
  assert.deepEqual(store.history(first.item.id), before.history)
  assert.deepEqual(store.events(), before.events)
  assert.equal(store.list(workspace, 10).matched, 1)
})

test("effective patch rejects an exhausted audit budget without mutation", () => {
  // Given
  const { store, calls } = fixture(2, 1)
  const created = store.create(command("first", "First"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const before = {
    calls: { ...calls },
    item: store.get(created.item.id),
    history: store.history(created.item.id),
    events: store.events(),
  }

  // When
  const result = store.patch({
    id: created.item.id,
    actorId: actor,
    baseRevision: revision(1),
    title: workItemTitle("Changed"),
  })

  // Then
  assert.deepEqual(result, {
    kind: "capacity_exceeded",
    resource: "audit_records",
    capacity: 1,
  })
  assert.deepEqual(calls, before.calls)
  assert.deepEqual(store.get(created.item.id), before.item)
  assert.deepEqual(store.history(created.item.id), before.history)
  assert.deepEqual(store.events(), before.events)
})

test("idempotent replay succeeds without generators when the audit budget is full", () => {
  // Given
  const { store, calls } = fixture(1, 1)
  const create = command("same", "Same")
  const created = store.create(create)
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const before = {
    calls: { ...calls },
    item: store.get(created.item.id),
    history: store.history(created.item.id),
    events: store.events(),
  }

  // When
  const result = store.create(create)

  // Then
  assert.equal(result.kind, "replayed")
  assert.deepEqual(calls, before.calls)
  assert.deepEqual(store.get(created.item.id), before.item)
  assert.deepEqual(store.history(created.item.id), before.history)
  assert.deepEqual(store.events(), before.events)
})

test("idempotency conflict does not use generators or mutate a full store", () => {
  // Given
  const { store, calls } = fixture(1, 1)
  const created = store.create(command("same", "First"))
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return
  const before = {
    calls: { ...calls },
    item: store.get(created.item.id),
    history: store.history(created.item.id),
    events: store.events(),
  }

  // When
  const result = store.create(command("same", "Different"))

  // Then
  assert.deepEqual(result, {
    kind: "idempotency_conflict",
    idempotencyKey: idempotencyKey("same"),
  })
  assert.deepEqual(calls, before.calls)
  assert.deepEqual(store.get(created.item.id), before.item)
  assert.deepEqual(store.history(created.item.id), before.history)
  assert.deepEqual(store.events(), before.events)
})

test("audit capacity failure does not reserve the rejected idempotency key", () => {
  // Given
  const { store, calls } = fixture(1, 0)

  // When
  const first = store.create(command("rejected", "First"))
  const second = store.create(command("rejected", "Different"))

  // Then
  const expected = { kind: "capacity_exceeded", resource: "audit_records", capacity: 0 }
  assert.deepEqual(first, expected)
  assert.deepEqual(second, expected)
  assert.deepEqual(calls, { clock: 0, itemId: 0, eventId: 0 })
  assert.deepEqual(store.events(), [])
})
