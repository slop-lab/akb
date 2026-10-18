import type { BlockDocument, BlockSnapshot } from "@block-editor/model"
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
  ContentDocumentSchema.parse({ version: 1, blocks: document.blocks.map(fromBlockSnapshot) })
