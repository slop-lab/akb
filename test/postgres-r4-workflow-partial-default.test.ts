import assert from "node:assert/strict"
import { test } from "node:test"
import type { ImportRecord } from "../src/contracts/r4/index.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { createInterchangeHttpFixture, validateAndCommit } from "./r4-interchange-http-fixture.ts"
import { exportSpace, records, retargetSpace, workflowCommand } from "./r4-workflow-http-helpers.ts"

test("authorized partial export with hidden source default commits additively", async () => {
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
    const replacement = await workflowCommand(source.request, {
      path: "/spaces/delivery/workflow/states",
      method: "POST",
      baseRevision: null,
      payload: {
        name: "Readable unstarted",
        category: "unstarted",
        color: "#0284C7",
        position: 5,
        isDefault: false,
      },
      key: "readable-unstarted",
    })
    assert.equal(replacement.status, 201, await replacement.clone().text())
    const [sourceDefault] = await source.sql<{ readonly id: string }[]>`
      select id from workflow_states where space_id='delivery' and active and is_default`
    if (sourceDefault === undefined) throw new TypeError("source default missing")
    await source.sql`update entity_acl_policies set mode='restricted'
      where entity_id=${sourceDefault.id}`
    await source.sql`delete from entity_acl_allowances where entity_id=${sourceDefault.id}`
    const exported = await exportSpace(source.request, "delivery")
    const exportedRecords = records(exported)
    const exportedSpace = exportedRecords.find((record) => Reflect.get(record, "kind") === "space")
    const exportedStates = exportedRecords.filter(
      (record) => Reflect.get(record, "kind") === "workflow_state",
    )
    if (exportedSpace === undefined) throw new TypeError("exported space missing")
    assert.equal(Reflect.get(exportedSpace, "workflowStateScope"), undefined)
    assert.equal(
      exportedStates.filter((record) => Reflect.get(record, "isDefault") === true).length,
      0,
    )
    const bytes = retargetSpace(exported, "restored")

    // When
    const result = await validateAndCommit(
      destination.request,
      bytes,
      "22222222-2222-4222-8222-222222222222",
    )

    // Then
    assert.equal(result.validated.status, 200)
    assert.equal(result.commit?.status, 200, await result.commit?.clone().text())
    const [counts] = await destination.sql<
      {
        readonly active: number
        readonly defaults: number
        readonly default_revision: number
        readonly mappings: number
        readonly state_events: number
      }[]
    >`select count(*) filter (where active)::integer active,
        count(*) filter (where active and is_default)::integer defaults,
        max(revision) filter (where active and is_default)::integer default_revision,
        (select count(*)::integer from import_record_ids) mappings,
        (select count(*)::integer from entity_events_v1 where subject_kind='workflow_state') state_events
      from workflow_states where space_id='restored'`
    assert.deepEqual(counts, {
      active: 6,
      defaults: 1,
      default_revision: 1,
      mappings: 6,
      state_events: 1,
    })
  } finally {
    await source.close()
    await destination.close()
  }
})

test("marked workflows reject missing, multiple, and inactive defaults with typed 400", async () => {
  const fixture = await createInterchangeHttpFixture()
  try {
    for (const [index, workflow] of invalidWorkflows().entries()) {
      const bytes = `${workflow.map((record) => JSON.stringify(record)).join("\n")}\n`
      const result = await validateAndCommit(
        fixture.request,
        bytes,
        `33333333-3333-4333-8333-33333333333${index + 1}`,
      )
      assert.equal(result.validated.status, 400)
      assert.equal(result.commit, null)
    }
  } finally {
    await fixture.close()
  }
})

function invalidWorkflows(): readonly (readonly ImportRecord[])[] {
  const manifest = {
    kind: "manifest",
    version: 1,
    importId: "44444444-4444-4444-8444-444444444444",
    workspaceId: "w",
  } as const
  const space = {
    kind: "space",
    externalId: "space",
    key: "INV",
    name: "Invalid",
    workflowStateScope: "active",
  } as const
  const states = (["backlog", "unstarted", "started", "completed", "canceled"] as const).map(
    (category, position) => ({
      kind: "workflow_state" as const,
      externalId: `state-${category}`,
      spaceId: "space",
      name: category,
      category,
      color: "#64748B",
      position,
      isDefault: category === "unstarted",
      active: true,
    }),
  )
  const missing = states.map((state) => ({ ...state, isDefault: false }))
  const multiple = states.map((state) => ({
    ...state,
    isDefault: state.category === "unstarted" || state.category === "started",
  }))
  const inactive = states.map((state) =>
    state.category === "unstarted" ? { ...state, active: false } : state,
  )
  return [missing, multiple, inactive].map((workflow) => [manifest, space, ...workflow])
}
