import { z } from "zod"
import {
  BlockTypeSchema,
  type ContentBlock,
  type ContentDocument,
  ContentDocumentSchema,
} from "../contracts/content/model.ts"
import { ContentInvariantError } from "./errors.ts"
import { validateDocumentTree } from "./tree.ts"

const DirectiveSchema = z.strictObject({
  id: z.string().min(1),
  type: BlockTypeSchema,
  level: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])
    .optional(),
  language: z.string().optional(),
  entityId: z.string().optional(),
  artifactId: z.string().optional(),
})

export function documentToMarkdown(document: ContentDocument): string {
  validateDocumentTree(document)
  return `${document.blocks.map(writeBlock).join("\n")}\n`
}

export function markdownToDocument(markdown: string): ContentDocument {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n")
  const parsed = parseBlocks(lines, 0, false)
  if (parsed.index < lines.length && lines.slice(parsed.index).some((line) => line.length > 0)) {
    throw new ContentInvariantError("markdown_trailing_content")
  }
  return validateDocumentTree(ContentDocumentSchema.parse({ version: 1, blocks: parsed.blocks }))
}

function writeBlock(block: ContentBlock): string {
  const metadata = JSON.stringify({
    id: block.id,
    type: block.type,
    ...(block.level === undefined ? {} : { level: block.level }),
    ...(block.language === undefined ? {} : { language: block.language }),
    ...(block.entityId === undefined ? {} : { entityId: block.entityId }),
    ...(block.artifactId === undefined ? {} : { artifactId: block.artifactId }),
  })
  const children = block.children.map(writeBlock).join("\n")
  return `:::afw-block ${metadata}\n${renderText(block)}\n${children}${children.length === 0 ? "" : "\n"}:::`
}

function renderText(block: ContentBlock): string {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(block.level ?? 1)} ${block.text}`
    case "code":
      return `\`\`\`${block.language ?? "text"}\n${block.text}\n\`\`\``
    case "quote":
      return block.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")
    case "callout":
      return `> [!NOTE]\n${block.text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}`
    case "list_item":
      return `- ${block.text}`
    case "entity_embed":
      return `@[entity:${block.entityId ?? ""}] ${block.text}`
    case "artifact_embed":
      return `@[artifact:${block.artifactId ?? ""}] ${block.text}`
    case "paragraph":
    case "list":
    case "table":
      return block.text
    default:
      return assertNever(block.type)
  }
}

function parseBlocks(
  lines: readonly string[],
  start: number,
  nested: boolean,
): { readonly blocks: readonly ContentBlock[]; readonly index: number } {
  const blocks: ContentBlock[] = []
  let index = start
  while (index < lines.length) {
    if (lines[index] === ":::") {
      if (!nested) throw new ContentInvariantError("markdown_unexpected_close")
      return { blocks, index: index + 1 }
    }
    if (lines[index] === "") {
      index += 1
      continue
    }
    const match = /^:::afw-block (\{.*\})$/.exec(lines[index] ?? "")
    if (match === null) throw new ContentInvariantError("markdown_block_directive_required")
    const metadata = DirectiveSchema.parse(JSON.parse(match[1] ?? ""))
    const content = readRenderedText(lines, index + 1, metadata.type)
    const children = parseBlocks(lines, content.index, true)
    blocks.push({ ...metadata, text: content.text, children: children.blocks })
    index = children.index
  }
  if (nested) throw new ContentInvariantError("markdown_unclosed_block")
  return { blocks, index }
}

function readRenderedText(
  lines: readonly string[],
  start: number,
  type: ContentBlock["type"],
): { readonly text: string; readonly index: number } {
  const childIndex = lines.findIndex(
    (line, index) => index >= start && (line === ":::" || line.startsWith(":::afw-block ")),
  )
  if (childIndex < 0) throw new ContentInvariantError("markdown_unclosed_block")
  const rendered = lines.slice(start, childIndex)
  switch (type) {
    case "heading":
      return { text: (rendered[0] ?? "").replace(/^#{1,6} /, ""), index: childIndex }
    case "code":
      return { text: rendered.slice(1, -1).join("\n"), index: childIndex }
    case "quote":
      return { text: rendered.map(stripQuote).join("\n"), index: childIndex }
    case "callout":
      return { text: rendered.slice(1).map(stripQuote).join("\n"), index: childIndex }
    case "list_item":
      return { text: (rendered[0] ?? "").replace(/^- /, ""), index: childIndex }
    case "entity_embed":
    case "artifact_embed":
      return { text: (rendered[0] ?? "").replace(/^@\[[^\]]+\] ?/, ""), index: childIndex }
    case "paragraph":
    case "list":
    case "table":
      return { text: rendered.join("\n"), index: childIndex }
    default:
      return assertNever(type)
  }
}

function stripQuote(line: string): string {
  return line.replace(/^> ?/, "")
}

function assertNever(value: never): never {
  throw new ContentInvariantError(`unsupported_block_type:${value}`)
}
