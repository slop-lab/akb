import { z } from "zod"
import { type ContentBlock, type ContentDocument, ContentDocumentSchema } from "./model.ts"

export const ContentPageTemplateSchema = z.strictObject({
  id: z.enum(["blank", "common-guidance", "feature-brief", "decision-record"]),
  name: z.string(),
  description: z.string(),
  document: ContentDocumentSchema,
})

export type ContentPageTemplate = z.infer<typeof ContentPageTemplateSchema>

function document(blocks: ContentDocument["blocks"]): ContentDocument {
  return ContentDocumentSchema.parse({ version: 1, blocks })
}

function section(id: string, title: string): readonly ContentBlock[] {
  return [
    { id: `${id}-heading`, type: "heading", level: 2, text: title, children: [] },
    { id: `${id}-body`, type: "paragraph", text: "", children: [] },
  ]
}

export const CONTENT_PAGE_TEMPLATES = [
  {
    id: "blank",
    name: "Blank",
    description: "Start with an empty document.",
    document: document([{ id: "body", type: "paragraph", text: "", children: [] }]),
  },
  {
    id: "common-guidance",
    name: "Common guidance",
    description: "Manually maintain shared guidance, boundaries, exceptions, and review notes.",
    document: document([
      ...section("purpose", "Purpose"),
      ...section("principles", "Principles"),
      ...section("boundaries", "Boundaries"),
      ...section("exceptions", "Exceptions"),
      ...section("review-notes", "Review notes"),
    ]),
  },
  {
    id: "feature-brief",
    name: "Feature brief",
    description: "Specify a feature manually, including deliberate exceptions and open questions.",
    document: document([
      ...section("purpose", "Purpose"),
      ...section("observable-success", "Observable success / acceptance"),
      ...section("constraints", "Constraints"),
      ...section("deliberate-exceptions", "Deliberate exceptions"),
      ...section("out-of-scope", "Out of scope"),
      ...section("related-decisions", "Related decisions"),
      ...section("open-questions", "Open questions"),
    ]),
  },
  {
    id: "decision-record",
    name: "Decision record",
    description: "Record a decision, its context, and consequences.",
    document: document([
      ...section("decision", "Decision"),
      ...section("context", "Context"),
      ...section("alternatives", "Alternatives"),
      ...section("rationale", "Rationale"),
      ...section("consequences", "Consequences"),
      ...section("sources", "Sources"),
    ]),
  },
] as const satisfies readonly ContentPageTemplate[]
