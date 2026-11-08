import type { BlockDocument, BlockSnapshot } from "@slop-lab/blocks"
import type { ContentBlock, ContentDocument } from "../../../../../src/contracts/content/model.ts"
import { ContentDocumentSchema } from "../../../../../src/contracts/content/model.ts"

const toBlockSnapshot = (block: ContentBlock): BlockSnapshot => ({
  id: block.id,
  type: block.type,
  attrs: {
    ...(block.level === undefined ? {} : { level: block.level }),
    ...(block.language === undefined ? {} : { language: block.language }),
    ...(block.entityId === undefined ? {} : { entityId: block.entityId }),
    ...(block.artifactId === undefined ? {} : { artifactId: block.artifactId }),
  },
  content: block.text.length === 0 ? [] : [{ kind: "text", text: block.text, marks: [] }],
  ...(block.children.length === 0 ? {} : { children: block.children.map(toBlockSnapshot) }),
})

const textFrom = (block: BlockSnapshot): string =>
  block.content.flatMap((inline) => (inline.kind === "text" ? [inline.text] : [])).join("")

export class UnsupportedBlocksEditingError extends Error {
  override readonly name = "UnsupportedBlocksEditingError"
}

const assertCanonicalInlineContent = (block: BlockSnapshot): void => {
  for (const inline of block.content) {
    if (inline.kind !== "text")
      throw new UnsupportedBlocksEditingError(
        "This document contains inline content that Pages cannot safely edit yet.",
      )
    if (inline.marks.length > 0)
      throw new UnsupportedBlocksEditingError(
        "This document contains inline formatting that Pages cannot safely edit yet.",
      )
  }
  for (const child of block.children ?? []) assertCanonicalInlineContent(child)
}

const fromBlockSnapshot = (block: BlockSnapshot): unknown => {
  const { level, language, entityId, artifactId } = block.attrs
  return {
    id: block.id,
    type: block.type,
    text: textFrom(block),
    children: (block.children ?? []).map(fromBlockSnapshot),
    ...(typeof level === "number" ? { level } : {}),
    ...(typeof language === "string" ? { language } : {}),
    ...(typeof entityId === "string" ? { entityId } : {}),
    ...(typeof artifactId === "string" ? { artifactId } : {}),
  }
}

export const toBlocksDocument = (document: ContentDocument): BlockDocument => ({
  format: "block-editor/v0.3",
  blocks: document.blocks.map(toBlockSnapshot),
})

export const fromBlocksDocument = (document: BlockDocument): ContentDocument =>
  ContentDocumentSchema.parse({
    version: 1,
    blocks: document.blocks.map((block) => {
      assertCanonicalInlineContent(block)
      return fromBlockSnapshot(block)
    }),
  })
