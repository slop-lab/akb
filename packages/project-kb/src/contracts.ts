import { z } from "zod"

export const IdSchema = z.string().min(1).max(200)
export type ContentBlock = {
  readonly id: string
  readonly type:
    | "paragraph"
    | "heading"
    | "list"
    | "list_item"
    | "code"
    | "quote"
    | "table"
    | "callout"
    | "entity_embed"
    | "artifact_embed"
  readonly text: string
  readonly children: readonly ContentBlock[]
  readonly level?: 1 | 2 | 3 | 4 | 5 | 6 | undefined
  readonly language?: string | undefined
  readonly entityId?: string | undefined
  readonly artifactId?: string | undefined
}
export const ContentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() =>
  z.strictObject({
    id: IdSchema,
    type: z.enum([
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
    ]),
    text: z.string().max(100_000),
    children: z.array(ContentBlockSchema).max(1_000).readonly(),
    level: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])
      .optional(),
    language: z.string().max(100).optional(),
    entityId: IdSchema.optional(),
    artifactId: IdSchema.optional(),
  }),
)
export const ContentDocumentSchema = z.strictObject({
  version: z.literal(1),
  blocks: z.array(ContentBlockSchema).max(10_000).readonly(),
})
export type ContentDocument = z.infer<typeof ContentDocumentSchema>
export const PageSchema = z.strictObject({
  id: IdSchema,
  workspaceId: IdSchema,
  spaceId: IdSchema.nullable(),
  parentPageId: IdSchema.nullable(),
  title: z.string(),
  revision: z.number().int().positive(),
  lifecycle: z.enum(["active", "archived"]),
  document: ContentDocumentSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type Page = z.infer<typeof PageSchema>
export const NotebookResponseSchema = z.strictObject({
  projectId: IdSchema,
  notebook: PageSchema.nullable(),
})
export type NotebookResponse = z.infer<typeof NotebookResponseSchema>
export const CreateNotebookSchema = z.strictObject({ title: z.string().trim().min(1).max(500) })
export type CreateNotebook = z.infer<typeof CreateNotebookSchema>
export const PageResponseSchema = z.object({ page: PageSchema })
export const PagesResponseSchema = z.strictObject({ pages: z.array(PageSchema).readonly() })
export const MutationResponseSchema = z.object({
  result: z.object({ id: IdSchema }),
  revision: z.number().int().positive(),
})
export const TemplateIdSchema = z.enum([
  "blank",
  "project-overview",
  "music-brief",
  "map-brief",
  "experiment-log",
  "decision",
])
export type TemplateId = z.infer<typeof TemplateIdSchema>
export const CreateDocumentSchema = z.strictObject({
  parentPageId: IdSchema,
  title: z.string().trim().min(1).max(500),
  templateId: TemplateIdSchema,
})
export const SaveDocumentSchema = z.strictObject({
  id: IdSchema,
  revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(500),
  document: ContentDocumentSchema,
})

export function notebookPath(workspaceId: string, projectId: string): string {
  return `/api/project-kb/v1/workspaces/${encodeURIComponent(IdSchema.parse(workspaceId))}/projects/${encodeURIComponent(IdSchema.parse(projectId))}/notebook`
}

export { PROJECT_KB_TEMPLATES, documentFromTemplate } from "./templates.ts"
