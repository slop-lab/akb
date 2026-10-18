import { z } from "zod"
import { CommandEnvelopeSchema } from "../r4/command.ts"

export const PlanningIdSchema = z.string().trim().min(1).max(200)
export const PlanningNameSchema = z.string().trim().min(1).max(200)
export const PlanningDateSchema = z.iso.date()
export const PlanningCommandEnvelopeSchema = CommandEnvelopeSchema

export type PlanningCommandEnvelope = z.infer<typeof PlanningCommandEnvelopeSchema>
