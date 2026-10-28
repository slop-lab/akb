import assert from "node:assert/strict"
import { test } from "node:test"
import { CONTENT_PAGE_TEMPLATES } from "../src/contracts/content/templates.ts"
import {
  ContextReadRequestSchema,
  ContextSelectionManifestSchema,
  createContextSelectionDocument,
  DEFAULT_CONTEXT_MAX_BYTES,
  parseContextSelectionDocument,
} from "../src/contracts/content/workflow.ts"

test("context selection document round trips strict explicit references", () => {
  // Given
  const references = [
    { kind: "page", id: "page-one", revision: 2 },
    { kind: "knowledge", id: "decision-one", revision: 4 },
  ] as const

  // When
  const document = createContextSelectionDocument("workspace-one", references)
  const manifest = parseContextSelectionDocument(document)

  // Then
  assert.deepEqual(manifest, {
    format: "akb-context-selection.v1",
    workspaceId: "workspace-one",
    references,
  })
  assert.equal(document.blocks.length, 1)
  assert.deepEqual(document.blocks[0], {
    id: "akb-context-selection",
    type: "code",
    language: "json",
    text: JSON.stringify(manifest),
    children: [],
  })
})

test("context selection rejects duplicate references", () => {
  // Given
  const duplicate = { kind: "page", id: "page-one", revision: 1 } as const

  // When / Then
  assert.throws(() => createContextSelectionDocument("workspace-one", [duplicate, duplicate]))
})

test("context selection parser allows ordinary blocks around one manifest", () => {
  // Given
  const selection = createContextSelectionDocument("workspace-one", [
    { kind: "page", id: "page-one", revision: 1 },
  ])
  const invalid = {
    ...selection,
    blocks: [
      { id: "heading", type: "heading" as const, level: 2 as const, text: "Context", children: [] },
      ...selection.blocks,
      { id: "extra", type: "paragraph" as const, text: "extra", children: [] },
    ],
  }

  // When
  const manifest = parseContextSelectionDocument(invalid)

  // Then
  assert.equal(manifest.references[0]?.id, "page-one")
})

test("context selection parser rejects multiple matching manifest blocks", () => {
  // Given
  const selection = createContextSelectionDocument("workspace-one", [
    { kind: "page", id: "page-one", revision: 1 },
  ])
  const manifest = selection.blocks[0]
  if (manifest === undefined) throw new TypeError("selection manifest block is missing")
  const invalid = {
    ...selection,
    blocks: [manifest, { ...manifest, id: "akb-context-selection" }],
  }

  // When / Then
  assert.throws(() => parseContextSelectionDocument(invalid))
})

test("context selection manifest requires one to twenty-five unique references", () => {
  // Given
  const empty = {
    format: "akb-context-selection.v1",
    workspaceId: "workspace-one",
    references: [],
  }

  // When
  const result = ContextSelectionManifestSchema.safeParse(empty)

  // Then
  assert.equal(result.success, false)
  assert.equal(
    ContextSelectionManifestSchema.safeParse({
      ...empty,
      references: Array.from({ length: 26 }, (_, index) => ({
        kind: "page",
        id: `page-${index}`,
        revision: 1,
      })),
    }).success,
    false,
  )
})

test("context read request applies the sixty-four KiB default budget", () => {
  // Given / When
  const request = ContextReadRequestSchema.parse({
    references: [{ kind: "page", id: "page-one", revision: 1 }],
  })

  // Then
  assert.equal(request.maxBytes, DEFAULT_CONTEXT_MAX_BYTES)
})

test("content Page templates are ordinary valid documents with stable IDs", () => {
  // Given / When
  const ids = CONTENT_PAGE_TEMPLATES.map((template) => template.id)

  // Then
  assert.deepEqual(ids, ["blank", "common-guidance", "feature-brief", "decision-record"])
  assert.ok(CONTENT_PAGE_TEMPLATES.every((template) => template.document.version === 1))
  assert.ok(
    CONTENT_PAGE_TEMPLATES.every((template) =>
      template.document.blocks.every(
        (block) => block.type === "heading" || block.type === "paragraph",
      ),
    ),
  )
})

test("content Page templates expose the complete manual workflow sections", () => {
  // Given
  const expected = {
    "common-guidance": ["Purpose", "Principles", "Boundaries", "Exceptions", "Review notes"],
    "feature-brief": [
      "Purpose",
      "Observable success / acceptance",
      "Constraints",
      "Deliberate exceptions",
      "Out of scope",
      "Related decisions",
      "Open questions",
    ],
    "decision-record": [
      "Decision",
      "Context",
      "Alternatives",
      "Rationale",
      "Consequences",
      "Sources",
    ],
  } as const

  // When / Then
  for (const [templateId, headings] of Object.entries(expected)) {
    const template = CONTENT_PAGE_TEMPLATES.find((candidate) => candidate.id === templateId)
    assert.ok(template)
    assert.deepEqual(
      template.document.blocks
        .filter((block) => block.type === "heading")
        .map((block) => block.text),
      headings,
    )
    assert.equal(
      template.document.blocks.filter((block) => block.type === "paragraph").length,
      headings.length,
    )
  }
})
