import { z } from "zod"

export const RETRIEVAL_PROJECTIONS = ["ref", "card", "detail", "raw"] as const
export const RetrievalProjectionSchema = z.enum(RETRIEVAL_PROJECTIONS)
export const RetrievalBudgetSchema = z.strictObject({
  maxItems: z.number().int().min(1).max(100),
  maxTokens: z.number().int().min(32).max(100_000),
})
export const RetrievalRequestSchema = z.strictObject({
  operation: z.enum(["search_entities", "read_entities", "expand_entity"]),
  query: z.string().trim().max(500).default(""),
  ids: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  kinds: z.array(z.string().trim().min(1).max(100)).min(1).max(32),
  projection: RetrievalProjectionSchema,
  budget: RetrievalBudgetSchema,
  cursor: z.string().min(1).nullable().default(null),
})
export const DeltaRequestSchema = z.strictObject({
  sinceReceipt: z.uuid(),
  kinds: z.array(z.string().trim().min(1).max(100)).min(1).max(32),
  projection: RetrievalProjectionSchema,
  budget: RetrievalBudgetSchema,
})

export type RetrievalProjection = z.infer<typeof RetrievalProjectionSchema>
export type RetrievalRequest = z.infer<typeof RetrievalRequestSchema>
export type DeltaRequest = z.infer<typeof DeltaRequestSchema>
