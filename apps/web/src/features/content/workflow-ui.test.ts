import { describe, expect, test } from "vitest"
import { ApiError } from "../../lib/api.ts"
import {
  ContentDocumentReferenceSchema,
  ContextReadRequestSchema,
  createContextSelectionDocument,
} from "../../../../../src/contracts/content/workflow.ts"
import {
  agentContextRequest,
  appendContextReference,
  contextWorkflowErrorMessage,
  proposalSourcesFromContext,
  qualifiedReferenceHref,
  referencesFromSelectionPage,
} from "./workflow-ui.ts"

describe("qualifiedReferenceHref", () => {
  test("builds durable Page and Knowledge revision links", () => {
    expect(
      qualifiedReferenceHref(
        "workspace one",
        ContentDocumentReferenceSchema.parse({ kind: "page", id: "page-one", revision: 7 }),
      ),
    ).toBe("/workspaces/workspace%20one/pages/page-one?revision=7")
    expect(
      qualifiedReferenceHref(
        "workspace one",
        ContentDocumentReferenceSchema.parse({
          kind: "knowledge",
          id: "decision one",
          revision: 3,
        }),
      ),
    ).toBe("/workspaces/workspace%20one/knowledge/decision%20one?revision=3")
  })
})

describe("agentContextRequest", () => {
  test("serializes a credential-free request for a saved selection Page", () => {
    const request = JSON.parse(
      agentContextRequest(
        "workspace-one",
        ContextReadRequestSchema.parse({
          selectionPage: { id: "selection-page", revision: 4 },
          maxBytes: 65_536,
        }),
      ),
    )

    expect(request).toEqual({
      method: "POST",
      path: "/api/content/v1/workspaces/workspace-one/context",
      body: {
        selectionPage: { id: "selection-page", revision: 4 },
        maxBytes: 65_536,
      },
    })
    expect(JSON.stringify(request)).not.toContain("authorization")
    expect(JSON.stringify(request)).not.toContain("token")
  })
})

describe("referencesFromSelectionPage", () => {
  test("restores exact references only from the canonical selection manifest", () => {
    const references = [
      ContentDocumentReferenceSchema.parse({ kind: "page", id: "page-one", revision: 2 }),
      ContentDocumentReferenceSchema.parse({
        kind: "knowledge",
        id: "decision-one",
        revision: 5,
      }),
    ]

    const selection = createContextSelectionDocument("workspace-one", references)
    expect(
      referencesFromSelectionPage("workspace-one", {
        ...selection,
        blocks: [
          { id: "summary", type: "paragraph", text: "Editable context notes", children: [] },
          ...selection.blocks,
        ],
      }),
    ).toEqual(references)
    expect(
      referencesFromSelectionPage("workspace-one", {
        version: 1,
        blocks: [{ id: "body", type: "paragraph", text: "Ordinary Page", children: [] }],
      }),
    ).toBeNull()
  })
})

describe("contextWorkflowErrorMessage", () => {
  test("names malformed selections and byte-budget failures explicitly", () => {
    expect(
      contextWorkflowErrorMessage(
        new ApiError(422, "invalid_context_selection", "generic", {}),
        "fallback",
      ),
    ).toContain("valid Task context manifest")
    expect(
      contextWorkflowErrorMessage(
        new ApiError(422, "context_budget_exceeded", "generic", {}),
        "fallback",
      ),
    ).toContain("byte limit")
  })
})

describe("proposalSourcesFromContext", () => {
  test("includes every resolved source plus the saved selection Page", () => {
    const sources = proposalSourcesFromContext({
      scope: "explicit-selection",
      references: [
        ContentDocumentReferenceSchema.parse({ kind: "page", id: "page-one", revision: 2 }),
        ContentDocumentReferenceSchema.parse({
          kind: "knowledge",
          id: "knowledge-one",
          revision: 4,
        }),
      ],
      selectionPage: { id: "selection-one", revision: 3 },
      items: [],
      contentBytes: 0,
      maxBytes: 65_536,
    })

    expect(sources).toEqual([
      { kind: "entity", entityId: "page-one", revision: 2, role: "context" },
      { kind: "entity", entityId: "knowledge-one", revision: 4, role: "context" },
      { kind: "entity", entityId: "selection-one", revision: 3, role: "context" },
    ])
  })
})

describe("appendContextReference", () => {
  test("rejects invalid revisions and a twenty-sixth unique source", () => {
    const item = {
      kind: "knowledge",
      id: "knowledge-new",
      title: "Knowledge",
      revision: 1,
      lifecycle: "active",
    } as const
    expect(() => appendContextReference([], item, 0)).toThrow("positive integer")

    const references = Array.from({ length: 25 }, (_, index) =>
      ContentDocumentReferenceSchema.parse({
        kind: "knowledge",
        id: `knowledge-${index}`,
        revision: 1,
      }),
    )
    expect(() => appendContextReference(references, item, 1)).toThrow("at most 25")
    expect(appendContextReference(references.slice(0, 24), item, 1)).toHaveLength(25)
  })
})
