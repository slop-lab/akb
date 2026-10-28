import type { ContentDocument } from "../../../../../src/contracts/content/model.ts"
import {
  CONTEXT_SELECTION_BLOCK_ID,
  type ContentDocumentReference,
  ContentDocumentReferenceSchema,
  type ContentDocumentSummary,
  type ContextReadRequest,
  type ContextReadResponse,
  parseContextSelectionDocument,
} from "../../../../../src/contracts/content/workflow.ts"
import {
  type ProposalSource,
  ProposalSourceSchema,
} from "../../../../../src/contracts/knowledge/proposals.ts"
import { ApiError } from "../../lib/api.ts"

export function qualifiedReferenceHref(
  workspaceId: string,
  reference: ContentDocumentReference,
): string {
  const section = reference.kind === "page" ? "pages" : "knowledge"
  return `/workspaces/${encodeURIComponent(workspaceId)}/${section}/${encodeURIComponent(reference.id)}?revision=${reference.revision}`
}

export function agentContextRequest(workspaceId: string, body: ContextReadRequest): string {
  return JSON.stringify(
    {
      method: "POST",
      path: `/api/content/v1/workspaces/${encodeURIComponent(workspaceId)}/context`,
      body,
    },
    null,
    2,
  )
}

export function referencesFromSelectionPage(
  workspaceId: string,
  document: ContentDocument,
): readonly ContentDocumentReference[] | null {
  if (!document.blocks.some((block) => block.id === CONTEXT_SELECTION_BLOCK_ID)) return null
  const manifest = parseContextSelectionDocument(document)
  if (manifest.workspaceId !== workspaceId)
    throw new TypeError("context selection workspace does not match the active Workspace")
  return manifest.references
}

export function copyText(value: string): Promise<void> {
  return navigator.clipboard.writeText(value)
}

export function contextWorkflowErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError && caught.code === "invalid_context_selection")
    return "This Page does not contain a valid Task context manifest for this Workspace."
  if (caught instanceof ApiError && caught.code === "context_budget_exceeded")
    return "The selected revisions exceed the context byte limit. Increase the limit or remove sources."
  return caught instanceof Error ? caught.message : fallback
}

export function appendContextReference(
  references: readonly ContentDocumentReference[],
  item: ContentDocumentSummary,
  revision: number,
): readonly ContentDocumentReference[] {
  if (!Number.isSafeInteger(revision) || revision <= 0)
    throw new RangeError("Revision must be a positive integer.")
  const reference = ContentDocumentReferenceSchema.parse({ kind: item.kind, id: item.id, revision })
  if (
    references.some(
      (candidate) =>
        candidate.kind === reference.kind &&
        candidate.id === reference.id &&
        candidate.revision === reference.revision,
    )
  )
    return references
  if (references.length >= 25) throw new RangeError("A Task context can pin at most 25 sources.")
  return [...references, reference]
}

export function sameContextReference(
  left: ContentDocumentReference,
  right: ContentDocumentReference,
): boolean {
  return left.kind === right.kind && left.id === right.id && left.revision === right.revision
}

export function proposalSourcesFromContext(
  context: ContextReadResponse,
): readonly ProposalSource[] {
  const references = context.references.map((reference) =>
    ProposalSourceSchema.parse({
      kind: "entity",
      entityId: reference.id,
      revision: reference.revision,
      role: "context",
    }),
  )
  return context.selectionPage === null
    ? references
    : [
        ...references,
        ProposalSourceSchema.parse({
          kind: "entity",
          entityId: context.selectionPage.id,
          revision: context.selectionPage.revision,
          role: "context",
        }),
      ]
}
