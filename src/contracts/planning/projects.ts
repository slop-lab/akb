import { z } from "zod"
import { PlanningDateSchema, PlanningIdSchema, PlanningNameSchema } from "./common.ts"

export const MilestoneCreateSchema = z.strictObject({
  name: PlanningNameSchema,
  description: z.string().max(20_000).default(""),
  targetDate: PlanningDateSchema.nullable(),
  position: z.number().int().nonnegative(),
})
export const MilestoneUpdateSchema = MilestoneCreateSchema.partial()

export const ModuleCreateSchema = z.strictObject({
  name: PlanningNameSchema,
  description: z.string().max(20_000).default(""),
  ownerId: PlanningIdSchema.nullable(),
  startDate: PlanningDateSchema.nullable(),
  targetDate: PlanningDateSchema.nullable(),
  status: z.enum(["planned", "active", "completed", "canceled"]),
})
export const ModuleUpdateSchema = ModuleCreateSchema.partial()

export const ProjectUpdateCreateSchema = z.strictObject({
  health: z.enum(["on_track", "at_risk", "off_track"]),
  body: z.string().trim().min(1).max(50_000),
})

export const ProjectProgressSchema = z.strictObject({
  projectId: PlanningIdSchema,
  mode: z.enum(["estimate", "count"]),
  total: z.number().nonnegative(),
  completed: z.number().nonnegative(),
  blocked: z.number().int().nonnegative(),
  percent: z.number().min(0).max(100),
})
