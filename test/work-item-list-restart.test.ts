import assert from "node:assert/strict"
import { test } from "node:test"
import {
  jsonRequest,
  readErrorCode,
  readList,
  startHttpFixture,
  VALID_CREATE_BODY,
} from "./http-fixture.ts"

test("workspace list returns ordered cards in the bounded R2 envelope", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)
  await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest({ ...VALID_CREATE_BODY, title: "Second" }, "create-2"),
  )
  await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest({ ...VALID_CREATE_BODY, title: "First" }, "create-1"),
  )

  // When
  const response = await fixture.request("/api/workspaces/workspace-1/work-items")

  // Then
  assert.equal(response.status, 200)
  const body = await readList(response)
  assert.deepEqual(
    body.items.map((item) => item.id),
    ["work-item-1", "work-item-2"],
  )
  assert.deepEqual(body.completeness, { returned: 2, matched: 2, truncated: false })
  assert.deepEqual(body.omitted, [])
  assert.equal(body.nextCursor, null)
  assert.equal(typeof body.estimatedTokens, "number")
  assert.equal("snapshotId" in body, false)
  assert.equal("receiptId" in body, false)
})

test("a new in-memory server loses work items on restart", async (context) => {
  // Given
  const firstProcess = await startHttpFixture()
  context.after(firstProcess.close)
  await firstProcess.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest(VALID_CREATE_BODY, "create-1"),
  )
  await firstProcess.close()

  // When
  const restarted = await startHttpFixture()
  context.after(restarted.close)
  const response = await restarted.request("/api/work-items/work-item-1")

  // Then
  assert.equal(response.status, 404)
  assert.equal(await readErrorCode(response), "not_found")
})
