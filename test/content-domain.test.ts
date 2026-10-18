import assert from "node:assert/strict"
import { test } from "node:test"
import { documentToMarkdown, markdownToDocument } from "../src/content/markdown.ts"
import { validateDocumentTree } from "../src/content/tree.ts"
import type { ContentDocument } from "../src/contracts/content/model.ts"

const document: ContentDocument = {
  version: 1,
  blocks: [
    {
      id: "b-heading",
      type: "heading",
      text: "Design",
      level: 2,
      children: [],
    },
    {
      id: "b-callout",
      type: "callout",
      text: "Keep this stable",
      children: [{ id: "b-child", type: "paragraph", text: "Nested", children: [] }],
    },
  ],
}

test("stable block identities survive a Markdown roundtrip", () => {
  // Given
  const source = documentToMarkdown(document)

  // When
  const restored = markdownToDocument(source)

  // Then
  assert.deepEqual(restored, document)
})

test("duplicate block identities are rejected", () => {
  // Given
  const duplicate: ContentDocument = {
    version: 1,
    blocks: [
      { id: "same", type: "paragraph", text: "One", children: [] },
      { id: "same", type: "paragraph", text: "Two", children: [] },
    ],
  }

  // When / Then
  assert.throws(() => validateDocumentTree(duplicate), /duplicate_block_id/)
})

test("document depth is bounded", () => {
  // Given
  let child: ContentDocument["blocks"][number] = {
    id: "depth-17",
    type: "paragraph",
    text: "Bottom",
    children: [],
  }
  for (let depth = 16; depth >= 1; depth -= 1) {
    child = { id: `depth-${depth}`, type: "quote", text: "", children: [child] }
  }

  // When / Then
  assert.throws(
    () => validateDocumentTree({ version: 1, blocks: [child] }),
    /document_depth_exceeded/,
  )
})
