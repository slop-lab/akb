import type { ImportRecord } from "../contracts/r4/index.ts"
import { ImportValidationError } from "./import-service.ts"

export function validateWorkflowStates(records: readonly ImportRecord[]): void {
  const spaces = records.filter((record) => record.kind === "space")
  for (const space of spaces) {
    const states = records
      .filter(isWorkflowState)
      .filter((record) => record.spaceId === space.externalId)
    if (states.filter((state) => state.active).length > 20)
      throw new ImportValidationError("workflow has at most 20 active states")
    if (states.some((state) => !state.active && state.isDefault === true))
      throw new ImportValidationError("inactive workflow state cannot be default")
    const positions = states.flatMap((state) =>
      state.position === undefined ? [] : [state.position],
    )
    if (new Set(positions).size !== positions.length)
      throw new ImportValidationError("workflow state positions must be unique")
    if (states.filter((state) => state.active && state.isDefault === true).length > 1)
      throw new ImportValidationError("workflow has one default state")
  }
}

function isWorkflowState(
  record: ImportRecord,
): record is Extract<ImportRecord, { readonly kind: "workflow_state" }> {
  return record.kind === "workflow_state"
}
