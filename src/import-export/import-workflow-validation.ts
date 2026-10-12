import type { ImportRecord } from "../contracts/r4/index.ts"
import { ImportValidationError } from "./import-service.ts"

const WORKFLOW_CATEGORIES = ["backlog", "unstarted", "started", "completed", "canceled"] as const

export function validateWorkflowStates(records: readonly ImportRecord[]): void {
  const spaces = records.filter((record) => record.kind === "space")
  for (const space of spaces) {
    const states = records
      .filter(isWorkflowState)
      .filter((record) => record.spaceId === space.externalId)
    if (
      space.workflowStateScope !== undefined &&
      states.some(
        (state) =>
          state.color === undefined ||
          state.position === undefined ||
          state.isDefault === undefined,
      )
    ) {
      throw new ImportValidationError("complete workflow state attributes are required")
    }
    if (space.workflowStateScope === "active" && states.some((state) => !state.active))
      throw new ImportValidationError("active workflow scope contains an inactive state")
    if (states.filter((state) => state.active).length > 20)
      throw new ImportValidationError("workflow has at most 20 active states")
    if (states.some((state) => !state.active && state.isDefault === true))
      throw new ImportValidationError("inactive workflow state cannot be default")
    const positions = states.flatMap((state) =>
      state.position === undefined ? [] : [state.position],
    )
    if (new Set(positions).size !== positions.length)
      throw new ImportValidationError("workflow state positions must be unique")
    const defaultCount = states.filter((state) => state.active && state.isDefault === true).length
    if (space.workflowStateScope !== undefined && defaultCount !== 1)
      throw new ImportValidationError("workflow has one active default state")
    if (
      space.workflowStateScope !== undefined &&
      !WORKFLOW_CATEGORIES.every((category) =>
        states.some((state) => state.active && state.category === category),
      )
    )
      throw new ImportValidationError("workflow has an active state in every category")
    if (
      space.workflowStateScope !== undefined &&
      !states.some(
        (state) => state.active && state.isDefault === true && state.category === "unstarted",
      )
    )
      throw new ImportValidationError("workflow default state is unstarted")
    if (space.workflowStateScope === undefined && defaultCount > 1)
      throw new ImportValidationError("workflow has one default state")
  }
}

function isWorkflowState(
  record: ImportRecord,
): record is Extract<ImportRecord, { readonly kind: "workflow_state" }> {
  return record.kind === "workflow_state"
}
