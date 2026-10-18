import { z } from "zod"
import { BlockIdSchema, ContentDocumentSchema, PageIdSchema } from "./model.ts"

export const CreatePageSchema = z.strictObject({
  pageId: PageIdSchema.optional(),
  spaceId: z.string().min(1).max(200).nullable().default(null),
  parentPageId: PageIdSchema.nullable().default(null),
  title: z.string().trim().min(1).max(500),
  document: ContentDocumentSchema,
})

export const PatchPageSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(500).optional(),
    parentPageId: PageIdSchema.nullable().optional(),
    document: ContentDocumentSchema.optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined || value.parentPageId !== undefined || value.document !== undefined,
    "patch must change at least one section",
  )

export const RestorePageSchema = z.strictObject({
  revision: z.number().int().positive(),
})

export const ArchivePageSchema = z.strictObject({})

export const CreateInlineCommentSchema = z.strictObject({
  commentId: z.string().min(1).max(200).optional(),
  blockId: BlockIdSchema,
  body: z.string().trim().min(1).max(20_000),
})

export const UpdatePresenceSchema = z.strictObject({
  blockId: BlockIdSchema.nullable(),
  cursor: z.number().int().nonnegative().nullable(),
})

export const ImportPageSchema = z.strictObject({
  pageId: PageIdSchema.optional(),
  spaceId: z.string().min(1).max(200).nullable().default(null),
  parentPageId: PageIdSchema.nullable().default(null),
  title: z.string().trim().min(1).max(500),
  markdown: z.string().max(2_000_000),
})

export type CreatePage = z.infer<typeof CreatePageSchema>
export type PatchPage = z.infer<typeof PatchPageSchema>
export type RestorePage = z.infer<typeof RestorePageSchema>
export type ArchivePage = z.infer<typeof ArchivePageSchema>
export type CreateInlineComment = z.infer<typeof CreateInlineCommentSchema>
export type UpdatePresence = z.infer<typeof UpdatePresenceSchema>
export type ImportPage = z.infer<typeof ImportPageSchema>
