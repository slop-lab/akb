import type { WorkItemId, WorkspaceId } from "./identifiers.ts"
import type { CreateResult, CreateWorkItem, PatchResult, PatchWorkItem, WorkItem } from "./model.ts"

export type WorkItemList = {
  readonly items: readonly WorkItem[]
  readonly matched: number
}

type StoreResult<T> = T | Promise<T>

export interface WorkItemStore {
  readonly supportsScopedCreate?: true
  create(command: CreateWorkItem): StoreResult<CreateResult>
  patch(command: PatchWorkItem): StoreResult<PatchResult>
  get(id: WorkItemId): StoreResult<WorkItem | undefined>
  list(workspaceId: WorkspaceId, limit: number): StoreResult<WorkItemList>
}
