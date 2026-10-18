import { z } from "zod"
import { PlanningDateSchema, PlanningIdSchema, PlanningNameSchema } from "./common.ts"

export const CycleStatusSchema = z.enum(["upcoming", "active", "completed", "archived"])
export const RolloverPolicySchema = z.enum(["automatic", "reviewed"])
const CycleFieldsSchema = z.strictObject({
  name: PlanningNameSchema,
  startDate: PlanningDateSchema,
  endDate: PlanningDateSchema,
  goal: z.string().max(10_000).default(""),
  capacityHint: z.number().nonnegative().nullable().default(null),
  rolloverPolicy: RolloverPolicySchema.default("reviewed"),
})
export const CycleCreateSchema = CycleFieldsSchema.refine(
  (value) => value.startDate <= value.endDate,
  {
    path: ["endDate"],
    message: "end date must not precede start date",
  },
)
export const CycleUpdateSchema = CycleFieldsSchema.partial().extend({
  status: CycleStatusSchema.optional(),
})
export const CycleRolloverSchema = z.strictObject({
  targetCycleId: PlanningIdSchema,
  targetCycleRevision: z.number().int().positive(),
  workItems: z
    .array(z.strictObject({ id: PlanningIdSchema, revision: z.number().int().positive() }))
    .max(500)
    .readonly(),
})

export const WorkPlanningSchema = z.strictObject({
  estimate: z.number().positive().max(1_000_000).nullable(),
  cycleId: PlanningIdSchema.nullable(),
  milestoneId: PlanningIdSchema.nullable(),
  moduleIds: z.array(PlanningIdSchema).max(100).readonly(),
})
