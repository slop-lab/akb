import { z } from "zod"
import { ContentPageTemplateSchema } from "../contracts/content/templates.ts"
import {
  ContentDocumentDiscoveryQuerySchema,
  ContentDocumentDiscoveryResponseSchema,
  ContextReadRequestSchema,
  ContextReadResponseSchema,
} from "../contracts/content/workflow.ts"
import type { ReadToolSpec } from "./read-specs.ts"
import { EmptyInputSchema } from "./schemas.ts"

const DiscoveryInputSchema = ContentDocumentDiscoveryQuerySchema.extend({
  limit: z.number().int().min(1).max(100).default(20),
})

export const DOCUMENT_READ_TOOL_SPECS: readonly ReadToolSpec[] = [
  {
    id: "document_templates",
    description:
      "Read ordinary Page templates for shared guidance, feature briefs and decision records.",
    input: EmptyInputSchema,
    output: z.strictObject({ templates: z.array(ContentPageTemplateSchema).readonly() }),
    request: () => ({ method: "GET", path: "content/v1/workspaces/:workspaceId/templates" }),
    snapshot: false,
  },
  {
    id: "documents_find",
    description:
      "Find authorized active Page or Knowledge title summaries. Discovery is live; pin a returned revision before reading context.",
    input: DiscoveryInputSchema,
    output: ContentDocumentDiscoveryResponseSchema,
    request: (input) => {
      const query = new URLSearchParams({
        kind: String(input["kind"]),
        query: String(input["query"] ?? ""),
        limit: String(input["limit"] ?? 20),
        afterId: String(input["afterId"] ?? ""),
      })
      return { method: "GET", path: `content/v1/workspaces/:workspaceId/documents?${query}` }
    },
    snapshot: false,
  },
  {
    id: "document_context",
    description:
      "Read exact Page and Knowledge revisions from explicit references or a saved selection Page. All sources must be authorized and fit the byte budget; links are not expanded.",
    input: ContextReadRequestSchema,
    output: ContextReadResponseSchema,
    request: (input) => ({
      method: "POST",
      path: "content/v1/workspaces/:workspaceId/context",
      body: input,
    }),
    snapshot: false,
  },
]
