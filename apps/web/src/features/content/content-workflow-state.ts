import type { ContentDocumentReference } from "../../../../../src/contracts/content/workflow.ts"

export type ContentWorkflowDraft = {
  readonly references: readonly ContentDocumentReference[]
  readonly selectionPage: { readonly id: string; readonly revision: number } | null
}

export const EMPTY_CONTENT_WORKFLOW_DRAFT: ContentWorkflowDraft = {
  references: [],
  selectionPage: null,
}
