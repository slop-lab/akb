import assert from "node:assert/strict"
import { connect } from "node:net"
import { test } from "node:test"
import {
  BodyBudgetExceededErrorSchema,
  CapacityExceededErrorSchema,
} from "../src/http/error-schemas.ts"
import { MAX_JSON_BODY_BYTES } from "../src/http/request-body.ts"
import { jsonRequest, readWorkItem, startHttpFixture, VALID_CREATE_BODY } from "./http-fixture.ts"

test("aborted partial JSON does not terminate the server", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)
  const socket = connect(fixture.port, "127.0.0.1")
  await new Promise<void>((resolve) => socket.once("connect", resolve))

  // When
  socket.write(
    "POST /api/workspaces/workspace-1/work-items HTTP/1.1\r\nHost: localhost\r\n" +
      "Content-Type: application/json\r\nIdempotency-Key: aborted\r\nContent-Length: 100\r\n\r\n{",
  )
  socket.destroy()
  await new Promise<void>((resolve) => socket.once("close", resolve))
  const health = await fixture.request("/health")

  // Then
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { status: "ok" })
})

test("JSON body limit rejects limit plus one bytes truthfully", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)
  const oversized = `"${"x".repeat(MAX_JSON_BODY_BYTES - 1)}"`

  // When
  const response = await fixture.request("/api/workspaces/workspace-1/work-items", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "large" },
    body: oversized,
  })

  // Then
  assert.equal(Buffer.byteLength(oversized), MAX_JSON_BODY_BYTES + 1)
  assert.equal(response.status, 413)
  assert.equal(
    BodyBudgetExceededErrorSchema.parse(await response.json()).error.code,
    "budget_exceeded",
  )
})

test("semantic no-op PATCH returns the current item without a revision", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)
  await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest(VALID_CREATE_BODY, "create-1"),
  )

  // When
  const response = await fixture.request("/api/work-items/work-item-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: "actor-1", baseRevision: 1, title: "Ship the slice" }),
  })

  // Then
  assert.equal(response.status, 200)
  assert.equal((await readWorkItem(response)).item.revision, 1)
})

test("create returns item capacity as a truthful HTTP 507 envelope", async (context) => {
  // Given
  const fixture = await startHttpFixture({ itemCapacity: 0, auditRecordCapacity: 1 })
  context.after(fixture.close)

  // When
  const response = await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest(VALID_CREATE_BODY, "capacity-create"),
  )

  // Then
  assert.equal(response.status, 507)
  const body = CapacityExceededErrorSchema.parse(await response.json())
  assert.equal(body.error.code, "budget_exceeded")
  assert.deepEqual(body.error.details, { resource: "items", capacity: 0 })
})

test("effective patch returns audit capacity as a truthful HTTP 507 envelope", async (context) => {
  // Given
  const fixture = await startHttpFixture({ itemCapacity: 1, auditRecordCapacity: 1 })
  context.after(fixture.close)
  const created = await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest(VALID_CREATE_BODY, "capacity-patch"),
  )
  assert.equal(created.status, 201)

  // When
  const response = await fixture.request("/api/work-items/work-item-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: "actor-1", baseRevision: 1, title: "Changed" }),
  })

  // Then
  assert.equal(response.status, 507)
  const body = CapacityExceededErrorSchema.parse(await response.json())
  assert.equal(body.error.code, "budget_exceeded")
  assert.deepEqual(body.error.details, { resource: "audit_records", capacity: 1 })
})
