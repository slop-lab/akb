import type { ImportRecord } from "../contracts/r4/index.ts"

export function nextStatePosition(
  record: Extract<ImportRecord, { readonly kind: "workflow_state" }>,
  records: readonly ImportRecord[],
): number {
  return (
    records
      .filter(isWorkflowState)
      .filter((item) => item.spaceId === record.spaceId)
      .findIndex((item) => item.externalId === record.externalId) + 5
  )
}

function isWorkflowState(
  record: ImportRecord,
): record is Extract<ImportRecord, { readonly kind: "workflow_state" }> {
  return record.kind === "workflow_state"
}
