import assert from "node:assert/strict"
import { test } from "node:test"
import { RevisionConflictErrorSchema } from "../src/http/error-schemas.ts"
import { jsonRequest, readWorkItem, startHttpFixture, VALID_CREATE_BODY } from "./http-fixture.ts"

test("same-process concurrent same-base PATCH preserves one winner", async (context) => {
  // Given
  const fixture = await startHttpFixture()
  context.after(fixture.close)
  const created = await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest(VALID_CREATE_BODY, "concurrent-create"),
  )
  assert.equal(created.status, 201)
  const contenders = ["First contender", "Second contender"] as const
  const patch = (title: (typeof contenders)[number]): RequestInit => ({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: "actor-1", baseRevision: 1, title }),
  })

  // When
  const firstRequest = fixture.request("/api/work-items/work-item-1", patch(contenders[0]))
  const secondRequest = fixture.request("/api/work-items/work-item-1", patch(contenders[1]))
  const responses = await Promise.all([firstRequest, secondRequest])

  // Then
  assert.deepEqual(
    responses.map((response) => response.status).sort((left, right) => left - right),
    [200, 409],
  )
  const conflict = responses.find((response) => response.status === 409)
  assert.ok(conflict)
  assert.deepEqual(RevisionConflictErrorSchema.parse(await conflict.json()).error.details, {
    expected: 1,
    actual: 2,
  })
  const current = await fixture.request("/api/work-items/work-item-1")
  const currentItem = (await readWorkItem(current)).item
  assert.equal(currentItem.revision, 2)
  assert.equal(contenders.filter((title) => title === currentItem.title).length, 1)
})
