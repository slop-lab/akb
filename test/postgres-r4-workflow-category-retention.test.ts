import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { createInterchangeHttpFixture } from "./r4-interchange-http-fixture.ts"

const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()),
  }),
})

test("archive rejects removing the last active state in a workflow category without writes", async () => {
  // Given
  const fixture = await createInterchangeHttpFixture()
  try {
    await new SpaceAdmin(fixture.sql).create({
      workspaceId: "w",
      spaceId: "delivery",
      spaceName: "Delivery",
      visibility: "public",
    })
    const [state] = await fixture.sql<
      { readonly id: string; readonly revision: number }[]
    >`select id,revision::integer revision from workflow_states
      where space_id='delivery' and category='completed' and active`
    if (state === undefined) throw new TypeError("completed state missing")
    const before = await evidence(fixture.sql, state.id)

    // When
    const response = await fixture.request(
      `/api/commands/v1/workspaces/w/spaces/delivery/workflow/states/${state.id}/archive`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: "archive-last-category-state",
          idempotencyKey: "archive-last-category-state",
          baseRevision: state.revision,
          payload: {},
        }),
      },
    )

    // Then
    assert.equal(response.status, 409)
    assert.equal(
      ErrorResponseSchema.parse(await response.json()).error.code,
      "workflow_requires_category_state",
    )
    assert.deepEqual(await evidence(fixture.sql, state.id), before)
  } finally {
    await fixture.close()
  }
})

async function evidence(
  sql: Awaited<ReturnType<typeof createInterchangeHttpFixture>>["sql"],
  stateId: string,
) {
  const [row] = await sql<
    {
      readonly active: boolean
      readonly entity_revision: number
      readonly events: number
      readonly idempotency: number
      readonly revisions: number
      readonly state_revision: number
    }[]
  >`select ws.active,ws.revision::integer state_revision,e.current_revision::integer entity_revision,
      (select count(*)::integer from entity_events_v1 where subject_id=${stateId}) events,
      (select count(*)::integer from entity_revisions where entity_id=${stateId}) revisions,
      (select count(*)::integer from generic_command_idempotency where subject_id=${stateId}) idempotency
    from workflow_states ws join entities e on e.id=ws.id where ws.id=${stateId}`
  if (row === undefined) throw new TypeError("workflow state evidence missing")
  return row
}
