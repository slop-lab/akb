import assert from "node:assert/strict"
import { test } from "node:test"
import {
  actorId,
  eventId,
  humanPrincipalId,
  idempotencyKey,
  workItemId,
  workItemTitle,
  workspaceId,
} from "../src/work-items/identifiers.ts"
import { InMemoryWorkItemStore } from "../src/work-items/in-memory-store.ts"

const dependencies = {
  newWorkItemId: () => workItemId("item"),
  newEventId: () => eventId("event"),
  now: () => "2026-01-02T03:04:05.000Z",
}

test("store limits reject malformed custom values", () => {
  // Given
  const malformed = [
    { itemCapacity: Number.NaN, auditRecordCapacity: 1 },
    { itemCapacity: Number.POSITIVE_INFINITY, auditRecordCapacity: 1 },
    { itemCapacity: -1, auditRecordCapacity: 1 },
    { itemCapacity: 0.5, auditRecordCapacity: 1 },
    { itemCapacity: Number.MAX_SAFE_INTEGER + 1, auditRecordCapacity: 1 },
    { itemCapacity: 1 },
    { itemCapacity: 1, auditRecordCapacity: 1, extra: 1 },
  ]

  // When / Then
  for (const limits of malformed) {
    assert.throws(() => Reflect.construct(InMemoryWorkItemStore, [dependencies, limits]))
  }
})

test("zero limits are valid and constructor isolates caller mutation", () => {
  // Given
  const limits = { itemCapacity: 0, auditRecordCapacity: 0 }
  const store = new InMemoryWorkItemStore(dependencies, limits)

  // When
  limits.itemCapacity = 1
  limits.auditRecordCapacity = 1

  // Then
  assert.equal(Object.isFrozen(limits), false)
  const result = store.create({
    workspaceId: workspaceId("workspace"),
    title: workItemTitle("Title"),
    accountableOwnerId: humanPrincipalId("owner"),
    actorId: actorId("actor"),
    idempotencyKey: idempotencyKey("key"),
  })
  assert.deepEqual(result, { kind: "capacity_exceeded", resource: "items", capacity: 0 })
})
