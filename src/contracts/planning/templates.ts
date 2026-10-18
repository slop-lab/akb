import { z } from "zod"
import { PlanningIdSchema, PlanningNameSchema } from "./common.ts"

export const TemplateKindSchema = z.enum(["work", "project", "page", "agent_task"])
export const TemplateContentSchema = z.strictObject({
  type: z.string().trim().min(1).max(100),
  fields: z.record(z.string(), z.unknown()),
  labels: z.array(PlanningIdSchema).max(50).readonly(),
  relations: z.array(z.record(z.string(), z.unknown())).max(100).readonly(),
  checklist: z.array(z.string().trim().min(1).max(500)).max(200).readonly(),
  guidance: z.string().max(50_000),
})
export const TemplateCreateSchema = z.strictObject({
  name: PlanningNameSchema,
  kind: TemplateKindSchema,
  content: TemplateContentSchema,
})
export const TemplateRevisionCreateSchema = z.strictObject({ content: TemplateContentSchema })
export const TemplateApplySchema = z.strictObject({
  templateRevision: z.number().int().positive(),
  targetEntityId: PlanningIdSchema,
  targetKind: TemplateKindSchema,
})
