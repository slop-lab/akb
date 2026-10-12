import type { ImportRecord } from "../contracts/r4/index.ts"
import { ImportValidationError } from "./import-service.ts"

export function validateCompletion(records: readonly ImportRecord[]): void {
  const byId = new Map(
    records.flatMap((record) =>
      "externalId" in record ? [[record.externalId, record] as const] : [],
    ),
  )
  for (const record of records) {
    if (
      record.kind === "project" &&
      record.completedAt !== null &&
      record.completedAt !== undefined &&
      record.state !== "completed"
    ) {
      throw new ImportValidationError("project completion timestamp requires completed state")
    }
    if (
      record.kind === "work_item" &&
      record.completedAt !== null &&
      record.completedAt !== undefined
    ) {
      const state = byId.get(record.stateId)
      if (state?.kind !== "workflow_state" || state.category !== "completed") {
        throw new ImportValidationError(
          "work completion timestamp requires completed workflow state",
        )
      }
    }
  }
}
