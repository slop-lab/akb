import { z } from "zod"

const RevisionSchema = z.number().int().positive()
export const CycleSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  sequence: z.number(),
  name: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.string(),
  goal: z.string(),
  capacityHint: z.number().nullable(),
  rolloverPolicy: z.string(),
  revision: RevisionSchema,
})
export const CyclesResponseSchema = z.object({ cycles: z.array(CycleSchema).readonly() })
export const MilestoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  targetDate: z.string().nullable(),
  position: z.number(),
  revision: RevisionSchema,
})
export const ModuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  ownerId: z.string().nullable(),
  startDate: z.string().nullable(),
  targetDate: z.string().nullable(),
  status: z.string(),
  revision: RevisionSchema,
})
export const UpdateSchema = z.object({
  id: z.string(),
  health: z.string(),
  body: z.string(),
  publishedAt: z.string(),
  total: z.number(),
  completed: z.number(),
  blocked: z.number(),
  metricMode: z.string(),
  revision: RevisionSchema,
})
export const TimelineSchema = z.object({
  kind: z.string(),
  id: z.string(),
  name: z.string(),
  startDate: z.string().nullable(),
  targetDate: z.string().nullable(),
})
export const ProgressSchema = z.object({
  projectId: z.string(),
  mode: z.enum(["estimate", "count"]),
  total: z.number(),
  completed: z.number(),
  blocked: z.number(),
  percent: z.number(),
})
export const MilestonesResponseSchema = z.object({
  milestones: z.array(MilestoneSchema).readonly(),
})
export const ModulesResponseSchema = z.object({ modules: z.array(ModuleSchema).readonly() })
export const TimelineResponseSchema = z.object({ entries: z.array(TimelineSchema).readonly() })
export const UpdatesResponseSchema = z.object({ updates: z.array(UpdateSchema).readonly() })
export const PlanningBundleSchema = z.tuple([
  MilestonesResponseSchema,
  ModulesResponseSchema,
  ProgressSchema,
  TimelineResponseSchema,
  UpdatesResponseSchema,
])
export const InboxSchema = z.object({
  notifications: z
    .array(
      z.object({
        id: z.string(),
        sequence: z.number(),
        entityId: z.string(),
        payload: z.unknown(),
        createdAt: z.string(),
        readAt: z.string().nullable(),
      }),
    )
    .readonly(),
  hasMore: z.boolean(),
})
