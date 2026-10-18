import type { ContentBlock, ContentDocument } from "../contracts/content/model.ts"
import { ContentInvariantError } from "./errors.ts"

const MAX_BLOCKS = 10_000
const MAX_DEPTH = 16

export function validateDocumentTree(document: ContentDocument): ContentDocument {
  const ids = new Set<string>()
  const active = new Set<ContentBlock>()
  let count = 0

  function visit(block: ContentBlock, depth: number): void {
    if (depth > MAX_DEPTH) throw new ContentInvariantError("document_depth_exceeded")
    if (active.has(block)) throw new ContentInvariantError("document_cycle")
    if (ids.has(block.id)) throw new ContentInvariantError("duplicate_block_id")
    ids.add(block.id)
    count += 1
    if (count > MAX_BLOCKS) throw new ContentInvariantError("document_block_limit_exceeded")
    validateBlockFields(block)
    active.add(block)
    for (const child of block.children) visit(child, depth + 1)
    active.delete(block)
  }

  for (const block of document.blocks) visit(block, 1)
  return document
}

export function flattenDocument(document: ContentDocument): readonly ContentBlock[] {
  validateDocumentTree(document)
  const blocks: ContentBlock[] = []
  function append(block: ContentBlock): void {
    blocks.push(block)
    for (const child of block.children) append(child)
  }
  for (const block of document.blocks) append(block)
  return blocks
}

function validateBlockFields(block: ContentBlock): void {
  switch (block.type) {
    case "heading":
      if (block.level === undefined) throw new ContentInvariantError("heading_level_required")
      break
    case "code":
      if (block.language === undefined) throw new ContentInvariantError("code_language_required")
      break
    case "entity_embed":
      if (block.entityId === undefined)
        throw new ContentInvariantError("entity_embed_target_required")
      break
    case "artifact_embed":
      if (block.artifactId === undefined)
        throw new ContentInvariantError("artifact_embed_target_required")
      break
    case "paragraph":
    case "list":
    case "list_item":
    case "quote":
    case "table":
    case "callout":
      break
    default:
      assertNever(block.type)
  }
}

function assertNever(value: never): never {
  throw new ContentInvariantError(`unsupported_block_type:${value}`)
}
