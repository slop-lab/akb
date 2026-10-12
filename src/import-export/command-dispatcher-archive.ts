import type { ImportRecord } from "../contracts/r4/index.ts"
import type { CommandAction, CommandCall } from "../pm/commands/types.ts"
import { ImportValidationError } from "./import-service.ts"

export function archiveCommand(
  create: CommandCall,
  record: Exclude<ImportRecord, { readonly kind: "manifest" }>,
  entityId: string,
  revision: number,
): CommandCall | null {
  const archivedAt = "archivedAt" in record ? record.archivedAt : undefined
  if (
    record.kind === "workflow_state"
      ? record.active
      : archivedAt === null || archivedAt === undefined
  )
    return null
  const action = archiveAction(record.kind)
  if (action === null)
    throw new ImportValidationError(`${record.kind} archive cannot be preserved canonically`)
  return {
    ...create,
    action,
    commandId: `${create.commandId}:archive`,
    idempotencyKey: `${create.idempotencyKey}:archive`,
    baseRevision: revision,
    resourceId: entityId,
    payload: {},
    ...(archivedAt === null || archivedAt === undefined ? {} : { restoredAt: archivedAt }),
  }
}

function archiveAction(kind: ImportRecord["kind"]): CommandAction | null {
  switch (kind) {
    case "project":
      return "project.archive"
    case "label":
      return "label.archive"
    case "work_item":
      return "work-item.archive"
    case "relation":
      return "relation.archive"
    case "comment":
      return "comment.archive"
    case "saved_view":
      return "saved-view.archive"
    case "workflow_state":
      return "workflow-state.archive"
    case "manifest":
    case "space":
      return null
  }
}
