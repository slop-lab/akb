import type {
  ActorId,
  EventId,
  HumanPrincipalId,
  IdempotencyKey,
  Revision,
  WorkItemId,
  WorkItemTitle,
  WorkspaceId,
} from "./identifiers.ts"

export const WORK_ITEM_STATES = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const
export type WorkItemState = (typeof WORK_ITEM_STATES)[number]

export type WorkItem = {
  readonly id: WorkItemId
  readonly workspaceId: WorkspaceId
  readonly title: WorkItemTitle
  readonly state: WorkItemState
  readonly accountableOwnerId: HumanPrincipalId
  readonly revision: Revision
  readonly createdAt: string
  readonly updatedAt: string
}

export type CreateWorkItem = {
  readonly workspaceId: WorkspaceId
  readonly title: WorkItemTitle
  readonly accountableOwnerId: HumanPrincipalId
  readonly actorId: ActorId
  readonly idempotencyKey: IdempotencyKey
}

export type PatchWorkItem = {
  readonly id: WorkItemId
  readonly actorId: ActorId
  readonly baseRevision: Revision
  readonly title?: WorkItemTitle
  readonly state?: WorkItemState
}

export type WorkItemRevision = WorkItem

type WorkItemEventBase = {
  readonly id: EventId
  readonly workspaceId: WorkspaceId
  readonly sequence: number
  readonly time: string
  readonly actorId: ActorId
  readonly subjectId: WorkItemId
  readonly subjectRevision: Revision
}

export type WorkItemEvent = WorkItemEventBase &
  (
    | { readonly type: "work_item.created" }
    | {
        readonly type: "work_item.updated"
        readonly changedFields: readonly ("title" | "state")[]
      }
  )

export type CapacityExceeded = {
  readonly kind: "capacity_exceeded"
  readonly resource: "items" | "audit_records"
  readonly capacity: number
}

export type CreateResult =
  | { readonly kind: "created"; readonly item: WorkItem; readonly eventId: EventId }
  | { readonly kind: "replayed"; readonly item: WorkItem; readonly eventId: EventId }
  | { readonly kind: "idempotency_conflict"; readonly idempotencyKey: IdempotencyKey }
  | CapacityExceeded

export type PatchResult =
  | { readonly kind: "updated"; readonly item: WorkItem; readonly eventId: EventId }
  | { readonly kind: "unchanged"; readonly item: WorkItem }
  | { readonly kind: "not_found"; readonly id: WorkItemId }
  | {
      readonly kind: "revision_conflict"
      readonly expected: Revision
      readonly actual: Revision
    }
  | CapacityExceeded
