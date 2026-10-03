import type { WorkItemId, WorkspaceId } from "./identifiers.ts"
import type { CreateResult, CreateWorkItem, PatchResult, PatchWorkItem, WorkItem } from "./model.ts"

export type WorkItemList = {
  readonly items: readonly WorkItem[]
  readonly matched: number
}

export interface WorkItemStore {
  create(command: CreateWorkItem): CreateResult
  patch(command: PatchWorkItem): PatchResult
  get(id: WorkItemId): WorkItem | undefined
  list(workspaceId: WorkspaceId, limit: number): WorkItemList
}
