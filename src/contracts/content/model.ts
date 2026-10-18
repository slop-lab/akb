import { z } from "zod"

export const PageIdSchema = z.string().min(1).max(200).brand("PageId")
export const BlockIdSchema = z.string().min(1).max(200).brand("BlockId")
export const CommentIdSchema = z.string().min(1).max(200).brand("CommentId")

export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "list",
  "list_item",
  "code",
  "quote",
  "table",
  "callout",
  "entity_embed",
  "artifact_embed",
] as const

export const BlockTypeSchema = z.enum(BLOCK_TYPES)

export type ContentBlock = {
  readonly id: string
  readonly type: z.infer<typeof BlockTypeSchema>
  readonly text: string
  readonly children: readonly ContentBlock[]
  readonly level?: 1 | 2 | 3 | 4 | 5 | 6 | undefined
  readonly language?: string | undefined
  readonly entityId?: string | undefined
  readonly artifactId?: string | undefined
}

export const ContentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() =>
  z.strictObject({
    id: BlockIdSchema,
    type: BlockTypeSchema,
    text: z.string().max(100_000),
    children: z.array(ContentBlockSchema).max(1_000).readonly(),
    level: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])
      .optional(),
    language: z.string().max(100).optional(),
    entityId: z.string().min(1).max(200).optional(),
    artifactId: z.string().min(1).max(200).optional(),
  }),
)

export const ContentDocumentSchema = z.strictObject({
  version: z.literal(1),
  blocks: z.array(ContentBlockSchema).max(10_000).readonly(),
})

export type ContentDocument = z.infer<typeof ContentDocumentSchema>

export const PageSchema = z.strictObject({
  id: PageIdSchema,
  workspaceId: z.string(),
  spaceId: z.string().nullable(),
  parentPageId: PageIdSchema.nullable(),
  title: z.string(),
  revision: z.number().int().positive(),
  lifecycle: z.enum(["active", "archived"]),
  document: ContentDocumentSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export type Page = z.infer<typeof PageSchema>

export const PageHistoryEntrySchema = z.strictObject({
  revision: z.number().int().positive(),
  actorId: z.string(),
  createdAt: z.string().datetime(),
  title: z.string(),
  document: ContentDocumentSchema,
})

export const InlineCommentSchema = z.strictObject({
  id: CommentIdSchema,
  pageId: PageIdSchema,
  blockId: BlockIdSchema,
  authorId: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
})

export const PresenceSchema = z.strictObject({
  principalId: z.string(),
  blockId: BlockIdSchema.nullable(),
  cursor: z.number().int().nonnegative().nullable(),
  expiresAt: z.string().datetime(),
})

export type PageHistoryEntry = z.infer<typeof PageHistoryEntrySchema>
export type InlineComment = z.infer<typeof InlineCommentSchema>
export type Presence = z.infer<typeof PresenceSchema>
