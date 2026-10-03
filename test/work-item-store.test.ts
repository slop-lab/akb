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
import { WORK_ITEM_STATES } from "../src/work-items/model.ts"

const WORKSPACE_ID = workspaceId("workspace-1")
const OWNER_ID = humanPrincipalId("human-1")
const ACTOR_ID = actorId("actor-1")

test("work item states match the canonical workflow categories", () => {
  // Given
  const canonicalStates = ["backlog", "unstarted", "started", "completed", "canceled"]

  // When
  const states = [...WORK_ITEM_STATES]

  // Then
  assert.deepEqual(states, canonicalStates)
})

function createStore(): InMemoryWorkItemStore {
  const itemIds = ["work-item-1", "work-item-2"]
  const eventIds = ["event-1", "event-2", "event-3"]
  return new InMemoryWorkItemStore({
    newWorkItemId: () => workItemId(itemIds.shift() ?? "work-item-fallback"),
    newEventId: () => eventId(eventIds.shift() ?? "event-fallback"),
    now: () => "2026-01-02T03:04:05.000Z",
  })
}

test("create is idempotent for the same normalized command", () => {
  // Given
  const store = createStore()
  const command = {
    workspaceId: WORKSPACE_ID,
    title: workItemTitle("  Ship the slice  "),
    accountableOwnerId: OWNER_ID,
    actorId: ACTOR_ID,
    idempotencyKey: idempotencyKey("create-1"),
  }

  // When
  const first = store.create(command)
  const replay = store.create({ ...command, title: workItemTitle("Ship the slice") })

  // Then
  assert.equal(first.kind, "created")
  assert.equal(replay.kind, "replayed")
  if (first.kind !== "created" || replay.kind !== "replayed") return
  assert.deepEqual(replay.item, first.item)
  assert.equal(replay.eventId, first.eventId)
  assert.equal(store.history(first.item.id).length, 1)
  assert.deepEqual(store.events(), [
    {
      id: "event-1",
      workspaceId: WORKSPACE_ID,
      sequence: 1,
      type: "work_item.created",
      time: "2026-01-02T03:04:05.000Z",
      actorId: ACTOR_ID,
      subjectId: "work-item-1",
      subjectRevision: 1,
    },
  ])
})

test("create rejects reuse of an idempotency key for a different command", () => {
  // Given
  const store = createStore()
  const key = idempotencyKey("create-1")
  store.create({
    workspaceId: WORKSPACE_ID,
    title: workItemTitle("First title"),
    accountableOwnerId: OWNER_ID,
    actorId: ACTOR_ID,
    idempotencyKey: key,
  })

  // When
  const result = store.create({
    workspaceId: WORKSPACE_ID,
    title: workItemTitle("Different title"),
    accountableOwnerId: OWNER_ID,
    actorId: ACTOR_ID,
    idempotencyKey: key,
  })

  // Then
  assert.deepEqual(result, { kind: "idempotency_conflict", idempotencyKey: key })
  assert.equal(store.events().length, 1)
})

test("patch preserves immutable history and appends one semantic event", () => {
  // Given
  const store = createStore()
  const created = store.create({
    workspaceId: WORKSPACE_ID,
    title: workItemTitle("Original"),
    accountableOwnerId: OWNER_ID,
    actorId: ACTOR_ID,
    idempotencyKey: idempotencyKey("create-1"),
  })
  assert.notEqual(created.kind, "idempotency_conflict")
  assert.notEqual(created.kind, "capacity_exceeded")
  if (created.kind === "idempotency_conflict" || created.kind === "capacity_exceeded") return
  const retainedHistory = store.history(created.item.id)
  const retainedEvents = store.events()

  // When
  const result = store.patch({
    id: created.item.id,
    actorId: ACTOR_ID,
    baseRevision: revision(1),
    title: workItemTitle("Revised"),
    state: "started",
  })

  // Then
  assert.equal(result.kind, "updated")
  assert.equal(Object.isFrozen(retainedHistory), true)
  assert.equal(Object.isFrozen(retainedEvents), true)
  assert.equal(retainedHistory.length, 1)
  assert.equal(retainedEvents.length, 1)
  assert.deepEqual(
    store.history(created.item.id).map((entry) => [entry.revision, entry.title, entry.state]),
    [
      [1, "Original", "unstarted"],
      [2, "Revised", "started"],
    ],
  )
  assert.deepEqual(store.events()[1], {
    id: "event-2",
    workspaceId: WORKSPACE_ID,
    sequence: 2,
    type: "work_item.updated",
    time: "2026-01-02T03:04:05.000Z",
    actorId: ACTOR_ID,
    subjectId: created.item.id,
    subjectRevision: 2,
    changedFields: ["title", "state"],
  })
})

test("stale patch leaves current state, history, and events unchanged", () => {
  // Given
  const store = createStore()
  const created = store.create({
    workspaceId: WORKSPACE_ID,
    title: workItemTitle("Original"),
    accountableOwnerId: OWNER_ID,
    actorId: ACTOR_ID,
    idempotencyKey: idempotencyKey("create-1"),
  })
  assert.notEqual(created.kind, "idempotency_conflict")
  assert.notEqual(created.kind, "capacity_exceeded")
  if (created.kind === "idempotency_conflict" || created.kind === "capacity_exceeded") return
  store.patch({
    id: created.item.id,
    actorId: ACTOR_ID,
    baseRevision: revision(1),
    title: workItemTitle("Winner"),
  })

  // When
  const stale = store.patch({
    id: created.item.id,
    actorId: ACTOR_ID,
    baseRevision: revision(1),
    title: workItemTitle("Loser"),
  })

  // Then
  assert.deepEqual(stale, { kind: "revision_conflict", expected: 1, actual: 2 })
  assert.equal(store.get(created.item.id)?.title, "Winner")
  assert.equal(store.history(created.item.id).length, 2)
  assert.equal(store.events().length, 2)
})
