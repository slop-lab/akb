import { z } from "zod"
import { type ContentDocument, ContentDocumentSchema } from "./model.ts"

const MAX_CONTEXT_REFERENCES = 25
export const DEFAULT_CONTEXT_MAX_BYTES = 64 * 1024
export const MAX_CONTEXT_MAX_BYTES = 256 * 1024
export const CONTEXT_SELECTION_BLOCK_ID = "akb-context-selection" as const
export const CONTEXT_SELECTION_FORMAT = "akb-context-selection.v1" as const

const ReferenceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^/\\]+$/)
const PageReferenceSchema = z.strictObject({
  kind: z.literal("page"),
  id: ReferenceIdSchema,
  revision: z.number().int().positive(),
})
const KnowledgeReferenceSchema = z.strictObject({
  kind: z.literal("knowledge"),
  id: ReferenceIdSchema,
  revision: z.number().int().positive(),
})

export const ContentDocumentReferenceSchema = z.discriminatedUnion("kind", [
  PageReferenceSchema,
  KnowledgeReferenceSchema,
])

const ContextReferencesSchema = z
  .array(ContentDocumentReferenceSchema)
  .min(1)
  .max(MAX_CONTEXT_REFERENCES)
  .readonly()
  .superRefine((references, context) => {
    const keys = new Set<string>()
    for (const [index, reference] of references.entries()) {
      const key = `${reference.kind}:${reference.id}:${reference.revision}`
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "context references must be unique",
        })
      }
      keys.add(key)
    }
  })

export const ContextSelectionManifestSchema = z.strictObject({
  format: z.literal(CONTEXT_SELECTION_FORMAT),
  workspaceId: z.string().trim().min(1).max(200),
  references: ContextReferencesSchema,
})

export const ContentDocumentDiscoveryQuerySchema = z.strictObject({
  kind: z.enum(["page", "knowledge"]),
  query: z.string().trim().max(500).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  afterId: z.string().trim().max(200).default(""),
})

export const ContentDocumentSummarySchema = z.strictObject({
  kind: z.enum(["page", "knowledge"]),
  id: z.string(),
  title: z.string(),
  revision: z.number().int().positive(),
  lifecycle: z.literal("active"),
})

export const ContentDocumentDiscoveryResponseSchema = z.strictObject({
  items: z.array(ContentDocumentSummarySchema).readonly(),
  nextAfterId: z.string().nullable(),
  consistency: z.literal("live"),
})

const ContextMaxBytesSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_CONTEXT_MAX_BYTES)
  .default(DEFAULT_CONTEXT_MAX_BYTES)

export const ContextReadRequestSchema = z.union([
  z.strictObject({ references: ContextReferencesSchema, maxBytes: ContextMaxBytesSchema }),
  z.strictObject({
    selectionPage: z.strictObject({ id: ReferenceIdSchema, revision: z.number().int().positive() }),
    maxBytes: ContextMaxBytesSchema,
  }),
])

export const ContextReadItemSchema = z.strictObject({
  kind: z.enum(["page", "knowledge"]),
  id: z.string(),
  revision: z.number().int().positive(),
  schemaVersion: z.string(),
  revisionCreatedAt: z.string().datetime(),
  snapshot: z.record(z.string(), z.json()),
})

export const ContextReadResponseSchema = z.strictObject({
  scope: z.literal("explicit-selection"),
  references: ContextReferencesSchema,
  selectionPage: z
    .strictObject({ id: ReferenceIdSchema, revision: z.number().int().positive() })
    .nullable(),
  items: z.array(ContextReadItemSchema).readonly(),
  contentBytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().positive(),
})

export type ContentDocumentReference = z.infer<typeof ContentDocumentReferenceSchema>
export type ContentDocumentDiscoveryQuery = z.infer<typeof ContentDocumentDiscoveryQuerySchema>
export type ContentDocumentSummary = z.infer<typeof ContentDocumentSummarySchema>
export type ContextSelectionManifest = z.infer<typeof ContextSelectionManifestSchema>
export type ContextReadRequest = z.infer<typeof ContextReadRequestSchema>
export type ContextReadItem = z.infer<typeof ContextReadItemSchema>
export type ContextReadResponse = z.infer<typeof ContextReadResponseSchema>

export class ContextSelectionDocumentError extends Error {
  override readonly name = "ContextSelectionDocumentError"

  constructor() {
    super("invalid context selection document")
  }
}

export function createContextSelectionDocument(
  workspaceId: string,
  references: readonly ContentDocumentReference[],
): ContentDocument {
  const manifest = ContextSelectionManifestSchema.parse({
    format: CONTEXT_SELECTION_FORMAT,
    workspaceId,
    references,
  })
  return ContentDocumentSchema.parse({
    version: 1,
    blocks: [
      {
        id: CONTEXT_SELECTION_BLOCK_ID,
        type: "code",
        language: "json",
        text: JSON.stringify(manifest),
        children: [],
      },
    ],
  })
}

export function parseContextSelectionDocument(document: ContentDocument): ContextSelectionManifest {
  const parsed = ContentDocumentSchema.parse(document)
  const candidates = parsed.blocks.filter((block) => block.id === CONTEXT_SELECTION_BLOCK_ID)
  const block = candidates[0]
  if (
    candidates.length !== 1 ||
    block === undefined ||
    block.type !== "code" ||
    block.language !== "json" ||
    block.children.length !== 0
  ) {
    throw new ContextSelectionDocumentError()
  }
  const manifest: unknown = JSON.parse(block.text)
  return ContextSelectionManifestSchema.parse(manifest)
}
