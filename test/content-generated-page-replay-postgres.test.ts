import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { z } from "zod"
import { WorkHubPostgresFixture } from "./knowledge-work-hub-postgres-fixture.ts"

const PageCommandResultSchema = z.object({
  replayed: z.boolean(),
  result: z.object({ id: z.string() }),
})

let fixture: WorkHubPostgresFixture

before(async () => {
  fixture = await WorkHubPostgresFixture.create()
})

after(async () => fixture.close())

test("generated Page IDs remain stable across same-envelope command replay", async () => {
  // Given
  const envelope = fixture.commandEnvelope(null, {
    title: "Generated replay Page",
    document: {
      version: 1,
      blocks: [{ id: "body", type: "paragraph", text: "replay", children: [] }],
    },
  })

  // When
  const first = await fixture.post(
    "/api/content/v1/workspaces/workspace/pages",
    fixture.ownerToken,
    envelope,
  )
  const replay = await fixture.post(
    "/api/content/v1/workspaces/workspace/pages",
    fixture.ownerToken,
    envelope,
  )

  // Then
  assert.equal(first.status, 201, first.body)
  assert.equal(replay.status, 200, replay.body)
  const created = PageCommandResultSchema.parse(JSON.parse(first.body))
  const repeated = PageCommandResultSchema.parse(JSON.parse(replay.body))
  assert.equal(created.result.id, repeated.result.id)
  assert.equal(repeated.replayed, true)
})
