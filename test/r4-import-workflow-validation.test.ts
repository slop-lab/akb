import assert from "node:assert/strict"
import { test } from "node:test"
import type { ImportRecord } from "../src/contracts/r4/index.ts"
import { validateWorkflowStates } from "../src/import-export/import-workflow-validation.ts"

const state = {
  kind: "workflow_state",
  externalId: "state",
  spaceId: "space",
  name: "Review",
  category: "started",
  color: "#123456",
  position: 0,
  isDefault: false,
  active: true,
} as const

for (const workflowStateScope of ["active", "all"] as const)
  test(`${workflowStateScope} workflow scope requires one active default`, () => {
    // Given
    const records: readonly ImportRecord[] = [
      {
        kind: "space",
        externalId: "space",
        key: "IMP",
        name: "Imported",
        workflowStateScope,
      },
      state,
    ]

    // When / Then
    assert.throws(() => validateWorkflowStates(records), /workflow has one active default state/)
  })

test("markerless workflow records remain partial", () => {
  // Given
  const records: readonly ImportRecord[] = [
    { kind: "space", externalId: "space", key: "IMP", name: "Imported" },
    state,
  ]

  // When / Then
  assert.doesNotThrow(() => validateWorkflowStates(records))
})

test("marked workflow requires an active state in every canonical category", () => {
  const records = completeWorkflow().filter(
    (record) => record.kind !== "workflow_state" || record.category !== "canceled",
  )

  assert.throws(
    () => validateWorkflowStates(records),
    /workflow has an active state in every category/,
  )
})

test("marked workflow accepts an active default in any category", () => {
  const records = completeWorkflow().map((record) =>
    record.kind === "workflow_state"
      ? { ...record, isDefault: record.category === "started" }
      : record,
  )

  assert.doesNotThrow(() => validateWorkflowStates(records))
})

function completeWorkflow(): readonly ImportRecord[] {
  return [
    {
      kind: "space",
      externalId: "space",
      key: "IMP",
      name: "Imported",
      workflowStateScope: "active",
    },
    ...(["backlog", "unstarted", "started", "completed", "canceled"] as const).map(
      (category, position) => ({
        ...state,
        externalId: `state-${category}`,
        name: category,
        category,
        position,
        isDefault: category === "unstarted",
      }),
    ),
  ]
}
