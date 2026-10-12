import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { createInterchangeHttpFixture } from "./r4-interchange-http-fixture.ts"

let fixture: Awaited<ReturnType<typeof createInterchangeHttpFixture>>

beforeEach(async () => {
  fixture = await createInterchangeHttpFixture()
})

afterEach(async () => fixture.close())

test("export rejects a v1 graph with duplicate cross-kind external IDs", async () => {
  // Given
  await command("/spaces", {
    id: "anchor",
    key: "ANC",
    name: "Anchor",
    visibility: "private",
    description: "",
    icon: null,
    leadId: null,
  })
  const projectId = await command("/projects", {
    name: "Collision",
    slug: "collision",
    summary: "",
    ownerId: "owner",
    leadIds: [],
    participatingSpaceIds: ["anchor"],
    state: "active",
    health: "on_track",
    priority: "none",
    startDate: null,
    targetDate: null,
  })
  await command("/spaces", {
    id: projectId,
    key: "COL",
    name: "Collision",
    visibility: "private",
    description: "",
    icon: null,
    leadId: null,
  })

  // When
  const response = await fixture.request("/api/human/v1/workspaces/w/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ includeArchived: true }),
  })

  // Then
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: {
      code: "nonportable_graph",
      message: "nonportable_graph",
      retryable: false,
      details: {},
    },
  })
})

async function command(path: string, payload: unknown): Promise<string> {
  const key = randomUUID()
  const response = await fixture.request(`/api/commands/v1/workspaces/w${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: key, idempotencyKey: key, baseRevision: null, payload }),
  })
  assert.equal(response.status, 201, await response.clone().text())
  return z
    .object({ result: z.object({ id: z.string() }).loose() })
    .loose()
    .parse(await response.json()).result.id
}
