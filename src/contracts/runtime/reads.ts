import { z } from "zod"
import { RunIdSchema } from "./identifiers.ts"
import { RetrievalProjectionSchema } from "./retrieval.ts"
import { RunStateSchema } from "./run.ts"

export const RuntimeReadPageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.string().max(500).default(""),
})

export const RunInspectionResponseSchema = z.strictObject({
  id: RunIdSchema,
  workspace_id: z.string(),
  installation_id: z.string(),
  subject_ref: z.string(),
  directive_ref: z.string(),
  state: RunStateSchema,
  generation: z.coerce.number().int().positive(),
  depth: z.coerce.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const RuntimeActivityResponseSchema = z.strictObject({
  id: z.uuid(),
  generation: z.coerce.number().int().positive(),
  sequence: z.coerce.number().int().positive(),
  kind: z.string(),
  actorId: z.string(),
  durable: z.boolean(),
  body: z.record(z.string(), z.unknown()),
  references: z.array(z.string()).readonly(),
  createdAt: z.string(),
})
export const RuntimeReceiptResponseSchema = z.strictObject({
  id: z.uuid(),
  projection: RetrievalProjectionSchema,
  createdAt: z.string(),
  retentionUntil: z.string(),
})
export const RuntimeArtifactResponseSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  mediaType: z.string(),
  retentionClass: z.string(),
  digest: z.string().nullable(),
  byteSize: z.coerce.number().int().nonnegative(),
  complete: z.boolean(),
  createdAt: z.string(),
})

export const RuntimeActivityPageResponseSchema = page(RuntimeActivityResponseSchema)
export const RuntimeReceiptPageResponseSchema = page(RuntimeReceiptResponseSchema)
export const RuntimeArtifactPageResponseSchema = page(RuntimeArtifactResponseSchema)

function page<Item extends z.ZodType>(item: Item) {
  return z.strictObject({
    items: z.array(item).readonly(),
    nextAfter: z.string().nullable(),
    hasMore: z.boolean(),
  })
}
