import assert from "node:assert/strict"
import { test } from "node:test"
import {
  IdempotencyConflictErrorSchema,
  InvalidArgumentErrorSchema,
  RevisionConflictErrorSchema,
  WorkItemNotFoundErrorSchema,
} from "../src/http/error-schemas.ts"
import {
  type HttpFixture,
  jsonRequest,
  readErrorCode,
  readWorkItem,
  startHttpFixture,
  VALID_CREATE_BODY,
} from "./http-fixture.ts"

async function createItem(fixture: HttpFixture, key = "create-1"): Promise<Response> {
  return fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest(VALID_CREATE_BODY, key),
  )
}

test("POST creates a work item and replays the same normalized command", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)

  // When
  const created = await createItem(fixture)
  const replayed = await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest({ ...VALID_CREATE_BODY, title: "  Ship the slice " }, "create-1"),
  )

  // Then
  assert.equal(created.status, 201)
  assert.match(created.headers.get("content-type") ?? "", /^application\/json/)
  const createdBody = await readWorkItem(created)
  assert.deepEqual(await readWorkItem(replayed), createdBody)
  assert.deepEqual(createdBody, {
    item: {
      id: "work-item-1",
      workspaceId: "workspace-1",
      title: "Ship the slice",
      state: "unstarted",
      accountableOwnerId: "human-1",
      revision: 1,
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    },
  })
})

test("POST returns typed invalid_argument and idempotency_conflict envelopes", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)
  await createItem(fixture)

  // When
  const invalid = await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest({ ...VALID_CREATE_BODY, title: "   " }, "invalid-1"),
  )
  const conflict = await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest({ ...VALID_CREATE_BODY, title: "Different" }, "create-1"),
  )

  // Then
  assert.equal(invalid.status, 400)
  assert.match(invalid.headers.get("content-type") ?? "", /^application\/json/)
  assert.equal(
    InvalidArgumentErrorSchema.parse(await invalid.json()).error.code,
    "invalid_argument",
  )
  assert.equal(conflict.status, 409)
  const conflictBody = IdempotencyConflictErrorSchema.parse(await conflict.json())
  assert.equal(conflictBody.error.code, "idempotency_conflict")
  assert.deepEqual(conflictBody.error.details, { idempotencyKey: "create-1" })
})

test("POST requires Idempotency-Key and rejects unknown body fields", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)

  // When
  const missingKey = await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest(VALID_CREATE_BODY),
  )
  const unknownField = await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest({ ...VALID_CREATE_BODY, unexpected: true }, "create-1"),
  )

  // Then
  assert.equal(missingKey.status, 400)
  assert.equal(await readErrorCode(missingKey), "invalid_argument")
  assert.equal(unknownField.status, 400)
  assert.equal(await readErrorCode(unknownField), "invalid_argument")
})

test("GET reads an item and returns typed not_found", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)
  await createItem(fixture)

  // When
  const found = await fixture.request("/api/work-items/work-item-1")
  const missing = await fixture.request("/api/work-items/missing")

  // Then
  assert.equal(found.status, 200)
  assert.equal((await readWorkItem(found)).item.id, "work-item-1")
  assert.equal(missing.status, 404)
  const missingBody = WorkItemNotFoundErrorSchema.parse(await missing.json())
  assert.equal(missingBody.error.code, "not_found")
  assert.deepEqual(missingBody.error.details, { id: "missing" })
})

test("PATCH updates once and rejects a stale revision without mutation", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)
  await createItem(fixture)
  const patch = {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: "actor-1", baseRevision: 1, title: "Winner" }),
  }

  // When
  const updated = await fixture.request("/api/work-items/work-item-1", patch)
  const stale = await fixture.request("/api/work-items/work-item-1", {
    ...patch,
    body: JSON.stringify({ actorId: "actor-1", baseRevision: 1, state: "completed" }),
  })

  // Then
  assert.equal(updated.status, 200)
  assert.equal((await readWorkItem(updated)).item.revision, 2)
  assert.equal(stale.status, 409)
  assert.equal(
    RevisionConflictErrorSchema.parse(await stale.json()).error.code,
    "revision_conflict",
  )
  const current = await fixture.request("/api/work-items/work-item-1")
  assert.deepEqual((await readWorkItem(current)).item, {
    id: "work-item-1",
    workspaceId: "workspace-1",
    title: "Winner",
    state: "unstarted",
    accountableOwnerId: "human-1",
    revision: 2,
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
  })
})

test("PATCH requires at least one change", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)
  await createItem(fixture)

  // When
  const response = await fixture.request("/api/work-items/work-item-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: "actor-1", baseRevision: 1 }),
  })

  // Then
  assert.equal(response.status, 400)
  assert.equal(
    InvalidArgumentErrorSchema.parse(await response.json()).error.code,
    "invalid_argument",
  )
})

test("PATCH returns typed not_found for an absent work item", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)

  // When
  const response = await fixture.request("/api/work-items/missing", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: "actor-1", baseRevision: 1, state: "completed" }),
  })

  // Then
  assert.equal(response.status, 404)
  assert.equal(WorkItemNotFoundErrorSchema.parse(await response.json()).error.code, "not_found")
})
