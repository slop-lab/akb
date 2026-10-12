import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { createInterchangeHttpFixture, validateAndCommit } from "./r4-interchange-http-fixture.ts"
import {
  exportSpace,
  retargetSpace,
  withoutWorkflowScope,
  workflowAttributes,
  workflowCommand,
} from "./r4-workflow-http-helpers.ts"

const scenarios = [
  { category: "unstarted", legacy: true },
  { category: "started", legacy: false },
] as const

for (const scenario of scenarios)
  test(`publicly created custom ${scenario.category} default round-trips and replays`, async () => {
    // Given
    const source = await createInterchangeHttpFixture()
    const destination = await createInterchangeHttpFixture()
    try {
      await new SpaceAdmin(source.sql).create({
        workspaceId: "w",
        spaceId: "delivery",
        spaceName: "Delivery",
        visibility: "public",
      })
      const created = await workflowCommand(source.request, {
        path: "/spaces/delivery/workflow/states",
        method: "POST",
        baseRevision: null,
        payload: {
          name: `${scenario.category} custom default`,
          category: scenario.category,
          color: "#15803D",
          position: 5,
          isDefault: true,
        },
        key: `create-${scenario.category}-default`,
      })
      assert.equal(created.status, 201, await created.clone().text())
      const exported = await exportSpace(source.request, "delivery")
      const bytes = retargetSpace(
        scenario.legacy ? withoutWorkflowScope(exported) : exported,
        "restored",
      )

      // When
      const first = await validateAndCommit(
        destination.request,
        bytes,
        `11111111-1111-4111-8111-11111111111${scenario.category === "started" ? "2" : "1"}`,
      )

      // Then
      assert.equal(first.validated.status, 200)
      assert.equal(first.commit?.status, 200, await first.commit?.clone().text())
      const replay = await validateAndCommit(
        destination.request,
        bytes,
        `11111111-1111-4111-8111-11111111111${scenario.category === "started" ? "2" : "1"}`,
      )
      assert.equal(replay.commit?.status, 200, await replay.commit?.clone().text())
      assert.equal(
        z.object({ replayed: z.literal(true) }).parse(await replay.commit?.json()).replayed,
        true,
      )
      const restored = await exportSpace(destination.request, "restored")
      assert.deepEqual(workflowAttributes(restored), workflowAttributes(bytes))
      const [counts] = await destination.sql<
        { readonly active: number; readonly defaults: number; readonly mappings: number }[]
      >`select count(*) filter (where active)::integer active,
          count(*) filter (where active and is_default)::integer defaults,
          (select count(*)::integer from import_record_ids) mappings
        from workflow_states where space_id='restored'`
      assert.deepEqual(counts, { active: 6, defaults: 1, mappings: 7 })
    } finally {
      await source.close()
      await destination.close()
    }
  })
