import type { WorkPermission } from "../identity/types.ts"

export const ENTITY_EVENT_TYPES = [
  "entity.created",
  "entity.updated",
  "entity.archived",
  "entity.restored",
  "acl.changed",
  "relation.created",
  "relation.updated",
  "relation.archived",
  "comment.created",
  "comment.updated",
] as const

export type EntityEventType = (typeof ENTITY_EVENT_TYPES)[number]

export type EntityKindRegistration = {
  readonly kind: string
  readonly readPermission: WorkPermission
}

export const FOUNDATION_ENTITY_KINDS = [
  { kind: "work_item", readPermission: "work.read" },
  { kind: "comment", readPermission: "work.read" },
  { kind: "thread", readPermission: "work.read" },
  { kind: "relation", readPermission: "work.read" },
  { kind: "project", readPermission: "project.read" },
  { kind: "space", readPermission: "space.read" },
  { kind: "workflow", readPermission: "space.read" },
  { kind: "workflow_state", readPermission: "space.read" },
  { kind: "label", readPermission: "space.read" },
  { kind: "saved_view", readPermission: "view.read" },
] as const satisfies readonly EntityKindRegistration[]
