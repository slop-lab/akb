import { z } from "zod"
import {
  ActorIdSchema,
  EventIdSchema,
  IsoTimestampSchema,
  RevisionSchema,
  SpaceIdSchema,
  WorkItemIdSchema,
  WorkspaceIdSchema,
} from "../work-items/identifiers.ts"

const EventBase = {
  id: EventIdSchema,
  workspaceId: WorkspaceIdSchema,
  spaceId: SpaceIdSchema.optional(),
  sequence: z.number().int().positive(),
  time: IsoTimestampSchema,
  actorId: ActorIdSchema,
  subjectId: WorkItemIdSchema,
  subjectRevision: RevisionSchema,
} as const

export const WorkItemEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...EventBase, type: z.literal("work_item.created") }),
  z.strictObject({
    ...EventBase,
    type: z.literal("work_item.updated"),
    changedFields: z.array(z.enum(["title", "state"])),
  }),
])

export const EventPageSchema = z.strictObject({
  events: z.array(WorkItemEventSchema).max(100),
  hasMore: z.boolean(),
  nextAfter: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
