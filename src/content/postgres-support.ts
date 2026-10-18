import type { TransactionSql } from "postgres"
import { z } from "zod"
import {
  type ContentBlock,
  type ContentDocument,
  ContentDocumentSchema,
} from "../contracts/content/model.ts"
import { CommandInvariantError, EntityNotFoundError } from "../entities/errors.ts"
import type { JsonObject } from "../entities/mutation-types.ts"
import { linkEntityAccessDependency } from "../entities/registry.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { ContentInvariantError } from "./errors.ts"
import { flattenDocument, validateDocumentTree } from "./tree.ts"

const PageStateRowSchema = z.strictObject({
  title: z.string(),
  parent_page_id: z.string().nullable(),
  document: ContentDocumentSchema,
})

export type PageState = {
  readonly title: string
  readonly parentPageId: string | null
  readonly document: ContentDocument
}

export async function readPageState(
  transaction: TransactionSql,
  pageId: string,
  revision?: number,
): Promise<PageState> {
  const rows =
    revision === undefined
      ? await transaction`select d.title,d.parent_page_id,r.document
        from content_documents d join content_document_revisions r
          on r.page_id=d.id and r.revision=d.current_revision where d.id=${pageId}`
      : await transaction`select title,parent_page_id,document from content_document_revisions
        where page_id=${pageId} and revision=${revision}`
  const parsed = PageStateRowSchema.safeParse(rows[0])
  if (!parsed.success) throw new EntityNotFoundError(pageId)
  return {
    title: parsed.data.title,
    parentPageId: parsed.data.parent_page_id,
    document: validateDocumentTree(parsed.data.document),
  }
}

export async function requirePageDependency(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  pageId: string,
): Promise<void> {
  const rows = await transaction<{ readonly allowed: boolean }[]>`
    select entity_access_allowed(${principal.workspaceId},${pageId},
      ${principal.principalId},'content.read') allowed
    from content_documents where workspace_id=${principal.workspaceId} and id=${pageId}`
  if (rows[0]?.allowed !== true) throw new EntityNotFoundError(pageId)
}

export async function requireValidPageParent(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  pageId: string,
  parentPageId: string,
): Promise<void> {
  if (pageId === parentPageId) throw new ContentInvariantError("page_parent_cycle")
  await requirePageDependency(transaction, principal, parentPageId)
  const cycles = await transaction`with recursive descendants(id) as (
      select id from content_documents where parent_page_id=${pageId}
      union
      select d.id from content_documents d join descendants prior on d.parent_page_id=prior.id
    ) select 1 from descendants where id=${parentPageId}`
  if (cycles.length > 0) throw new ContentInvariantError("page_parent_cycle")
}

export async function replacePageDependency(
  transaction: TransactionSql,
  pageId: string,
  parentPageId: string | null,
): Promise<void> {
  await transaction`delete from entity_access_dependencies where entity_id=${pageId}
    and required_entity_id in (select id from entities where kind='page')`
  if (parentPageId !== null) {
    await linkEntityAccessDependency(transaction, pageId, parentPageId)
  }
}

export async function replaceBlockIndex(
  transaction: TransactionSql,
  pageId: string,
  document: ContentDocument,
): Promise<void> {
  validateDocumentTree(document)
  await transaction`delete from content_blocks where page_id=${pageId}`
  for (const block of flattenDocument(document)) {
    const parent = parentOf(document.blocks, block.id)
    const siblings = parent === null ? document.blocks : parent.children
    const position = siblings.findIndex((candidate) => candidate.id === block.id)
    await transaction`insert into content_blocks
      (page_id,block_id,parent_block_id,position,block_type,plain_text,entity_ref,artifact_ref)
      values (${pageId},${block.id},${parent?.id ?? null},${position},${block.type},${block.text},
        ${block.entityId ?? null},${block.artifactId ?? null})`
  }
}

export function pageSnapshot(
  pageId: string,
  workspaceId: string,
  revision: number,
  state: PageState,
  lifecycle: "active" | "archived",
): JsonObject {
  return {
    id: pageId,
    workspaceId,
    title: state.title,
    parentPageId: state.parentPageId,
    revision,
    lifecycle,
    document: state.document,
  }
}

export function requireNextRevision(
  targets: ReadonlyMap<string, { readonly nextRevision: number }>,
  entityId: string,
): number {
  const revision = targets.get(entityId)?.nextRevision
  if (revision === undefined) throw new CommandInvariantError("content_target_missing")
  return revision
}

function parentOf(blocks: readonly ContentBlock[], targetId: string): ContentBlock | null {
  for (const block of blocks) {
    if (block.children.some((child) => child.id === targetId)) return block
    const nested = parentOf(block.children, targetId)
    if (nested !== null) return nested
  }
  return null
}
