import { z } from "zod"
import type { ContentDocument } from "../../../../../src/contracts/content/model.ts"
import { PageHistoryEntrySchema, PageSchema } from "../../../../../src/contracts/content/model.ts"
import type { ScreenProps } from "../../app/types.ts"

export type ContentScreenProps = ScreenProps & {
  readonly initialPageId?: string
  readonly initialRevision?: number
  readonly initialRevisionError?: string
  readonly onLocationChange: (pageId: string, revision?: number) => void
}

export const PagesSchema = z.object({ pages: z.array(PageSchema).readonly() })
export const PageResponseSchema = z.object({
  page: PageSchema,
  projection: z.record(z.string(), z.unknown()).optional(),
})
export const HistorySchema = z.object({ revisions: z.array(PageHistoryEntrySchema).readonly() })
export const EMPTY_DOCUMENT: ContentDocument = {
  version: 1,
  blocks: [{ id: "paragraph:initial", type: "paragraph", text: "", children: [] }],
}
