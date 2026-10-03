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

const actor = actorId("nonmutation-actor")

function preparedStore() {
  const calls = { clock: 0, itemId: 0, eventId: 0 }
  const store = new InMemoryWorkItemStore(
    {
      now: () => {
        calls.clock += 1
        return "2026-01-02T03:04:05.000Z"
      },
      newWorkItemId: () => {
        calls.itemId += 1
        return workItemId(`nonmutation-item-${calls.itemId}`)
      },
      newEventId: () => {
        calls.eventId += 1
        return eventId(`nonmutation-event-${calls.eventId}`)
      },
    },
    { itemCapacity: 1, auditRecordCapacity: 1 },
  )
  const created = store.create({
    workspaceId: workspaceId("nonmutation-workspace"),
    title: workItemTitle("Original"),
    accountableOwnerId: humanPrincipalId("nonmutation-owner"),
    actorId: actor,
    idempotencyKey: idempotencyKey("nonmutation-key"),
  })
  assert.equal(created.kind, "created")
  if (created.kind !== "created") return assert.fail("fixture create failed")
  return { store, calls, item: created.item }
}

function snapshot(fixture: ReturnType<typeof preparedStore>) {
  return {
    calls: { ...fixture.calls },
    item: fixture.store.get(fixture.item.id),
    history: fixture.store.history(fixture.item.id),
    events: fixture.store.events(),
  }
}

test("no-op patch does not consume budget or mutate retained state", () => {
  // Given
  const fixture = preparedStore()
  const before = snapshot(fixture)

  // When
  const result = fixture.store.patch({
    id: fixture.item.id,
    actorId: actor,
    baseRevision: revision(1),
    title: workItemTitle("Original"),
  })

  // Then
  assert.equal(result.kind, "unchanged")
  assert.deepEqual(snapshot(fixture), before)
})

test("stale patch does not consume budget or mutate retained state", () => {
  // Given
  const fixture = preparedStore()
  const before = snapshot(fixture)

  // When
  const result = fixture.store.patch({
    id: fixture.item.id,
    actorId: actor,
    baseRevision: revision(2),
    title: workItemTitle("Changed"),
  })

  // Then
  assert.deepEqual(result, { kind: "revision_conflict", expected: 2, actual: 1 })
  assert.deepEqual(snapshot(fixture), before)
})

test("not-found patch does not consume budget or mutate retained state", () => {
  // Given
  const fixture = preparedStore()
  const before = snapshot(fixture)

  // When
  const result = fixture.store.patch({
    id: workItemId("missing"),
    actorId: actor,
    baseRevision: revision(1),
    title: workItemTitle("Changed"),
  })

  // Then
  assert.deepEqual(result, { kind: "not_found", id: workItemId("missing") })
  assert.deepEqual(snapshot(fixture), before)
})
