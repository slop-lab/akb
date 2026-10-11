import { z } from "zod"
import { QuerySnapshotSchema } from "./query.ts"

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const
export const STATE_CATEGORIES = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const
const EntityRefSchema = z.strictObject({ id: z.string(), name: z.string() })
const SpaceRefSchema = EntityRefSchema.extend({ key: z.string() }).strict()
const WorkflowStateSchema = EntityRefSchema.extend({
  category: z.enum(STATE_CATEGORIES),
  color: z.string(),
  position: z.number().int().nonnegative(),
}).strict()
export const WorkItemDetailSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  space: SpaceRefSchema,
  key: z.string(),
  revision: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  type: z.string(),
  workflowState: WorkflowStateSchema,
  stateCategory: z.enum(STATE_CATEGORIES),
  priority: z.enum(PRIORITIES),
  accountableOwner: EntityRefSchema,
  project: EntityRefSchema.nullable(),
  labels: z.array(EntityRefSchema).readonly(),
  startDate: z.iso.date().nullable(),
  dueDate: z.iso.date().nullable(),
  parentId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(),
})
export const WorkItemCardSchema = WorkItemDetailSchema
export const ProjectSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  summary: z.string(),
  owner: EntityRefSchema,
  leadIds: z.array(z.string()).readonly(),
  participatingSpaceIds: z.array(z.string()).readonly(),
  state: z.enum(["planned", "active", "paused", "completed", "canceled"]),
  health: z.enum(["on_track", "at_risk", "off_track"]),
  priority: z.enum(PRIORITIES),
  startDate: z.iso.date().nullable(),
  targetDate: z.iso.date().nullable(),
  completedAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  revision: z.number().int().positive(),
})
export const QueryPageSchema = z.strictObject({
  snapshot: QuerySnapshotSchema,
  items: z.array(WorkItemCardSchema).readonly(),
  completeness: z.strictObject({
    returned: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  nextCursor: z.string().nullable(),
})
export type WorkItemDetail = z.infer<typeof WorkItemDetailSchema>
export type Project = z.infer<typeof ProjectSchema>
export type QueryPage = z.infer<typeof QueryPageSchema>
