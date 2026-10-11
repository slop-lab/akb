import type { MutationResult } from "../../entities/mutation-types.ts"
import type { AuthenticatedPrincipal } from "../../identity/types.ts"

export const COMMAND_ACTIONS = [
  "space.create",
  "space.update",
  "space.access",
  "workflow.update",
  "workflow-state.create",
  "workflow-state.update",
  "workflow-state.archive",
  "label.create",
  "label.update",
  "label.archive",
  "project.create",
  "project.update",
  "project.archive",
  "project.restore",
  "work-item.create",
  "work-item.update",
  "work-item.archive",
  "work-item.restore",
  "relation.create",
  "relation.update",
  "relation.archive",
  "comment.create",
  "comment.update",
  "comment.archive",
  "saved-view.create",
  "saved-view.update",
  "saved-view.archive",
  "entity.access",
] as const

export type CommandAction = (typeof COMMAND_ACTIONS)[number]

export type CommandCall = {
  readonly workspaceId: string
  readonly principal: AuthenticatedPrincipal
  readonly commandId: string
  readonly idempotencyKey: string
  readonly baseRevision: number | null
  readonly action: CommandAction
  readonly route: string
  readonly resourceId: string | null
  readonly parentId: string | null
  readonly payload: unknown
  readonly restoredAt?: string
}

export interface CommandExecutor {
  execute(call: CommandCall): Promise<MutationResult>
}
