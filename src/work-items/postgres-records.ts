import { z } from "zod"
import {
  ActorIdSchema,
  EventIdSchema,
  HumanPrincipalIdSchema,
  RevisionSchema,
  WorkItemIdSchema,
  WorkItemTitleSchema,
  WorkspaceIdSchema,
} from "./identifiers.ts"
import { WORK_ITEM_STATES, type WorkItem, type WorkItemEvent } from "./model.ts"

const WorkItemRecordSchema = z.object({
  id: WorkItemIdSchema,
  workspace_id: WorkspaceIdSchema,
  title: WorkItemTitleSchema,
  state: z.enum(WORK_ITEM_STATES),
  accountable_owner_id: HumanPrincipalIdSchema,
  revision: z.coerce.number().pipe(RevisionSchema),
  created_at: z.date(),
  updated_at: z.date(),
})

const EventRecordSchema = z.strictObject({
  id: EventIdSchema,
  workspace_id: WorkspaceIdSchema,
  sequence: z.coerce.number().int().positive(),
  event_type: z.enum(["work_item.created", "work_item.updated"]),
  occurred_at: z.date(),
  actor_id: ActorIdSchema,
  subject_id: WorkItemIdSchema,
  subject_revision: z.coerce.number().pipe(RevisionSchema),
  changed_fields: z.array(z.enum(["title", "state"])).nullable(),
})

export function parseWorkItem(record: unknown): WorkItem {
  const value = WorkItemRecordSchema.parse(record)
  return Object.freeze({
    id: value.id,
    workspaceId: value.workspace_id,
    title: value.title,
    state: value.state,
    accountableOwnerId: value.accountable_owner_id,
    revision: value.revision,
    createdAt: value.created_at.toISOString(),
    updatedAt: value.updated_at.toISOString(),
  })
}

export function parseEvent(record: unknown): WorkItemEvent {
  const value = EventRecordSchema.parse(record)
  const base = {
    id: value.id,
    workspaceId: value.workspace_id,
    sequence: value.sequence,
    time: value.occurred_at.toISOString(),
    actorId: value.actor_id,
    subjectId: value.subject_id,
    subjectRevision: value.subject_revision,
  }
  switch (value.event_type) {
    case "work_item.created":
      return Object.freeze({ ...base, type: value.event_type })
    case "work_item.updated":
      return Object.freeze({
        ...base,
        type: value.event_type,
        changedFields: Object.freeze(value.changed_fields ?? []),
      })
    default:
      return assertNever(value.event_type)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected event type: ${value}`)
}
