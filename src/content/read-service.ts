import type { Sql } from "postgres"
import { z } from "zod"
import {
  BlockIdSchema,
  CommentIdSchema,
  ContentDocumentSchema,
  type InlineComment,
  type Page,
  type PageHistoryEntry,
  PageIdSchema,
  type Presence,
} from "../contracts/content/model.ts"
import { EntityNotFoundError } from "../entities/errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { documentToMarkdown } from "./markdown.ts"

const PageRowSchema = z.strictObject({
  id: PageIdSchema,
  workspace_id: z.string(),
  space_id: z.string().nullable(),
  parent_page_id: PageIdSchema.nullable(),
  title: z.string(),
  current_revision: z.coerce.number().int().positive(),
  lifecycle: z.enum(["active", "archived"]),
  document: ContentDocumentSchema,
  created_at: z.date(),
  updated_at: z.date(),
})
const HistoryRowSchema = z.strictObject({
  revision: z.coerce.number().int().positive(),
  actor_id: z.string(),
  created_at: z.date(),
  title: z.string(),
  document: ContentDocumentSchema,
})
const CommentRowSchema = z.strictObject({
  id: CommentIdSchema,
  page_id: PageIdSchema,
  block_id: BlockIdSchema,
  author_id: z.string(),
  body: z.string(),
  created_at: z.date(),
  resolved_at: z.date().nullable(),
})
const PresenceRowSchema = z.strictObject({
  principal_id: z.string(),
  block_id: BlockIdSchema.nullable(),
  cursor_offset: z.number().int().nonnegative().nullable(),
  expires_at: z.date(),
})

export class ContentReadService {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  async page(principal: AuthenticatedPrincipal, pageId: string): Promise<Page> {
    const rows = await this.#sql`select d.id,d.workspace_id,d.space_id,d.parent_page_id,d.title,
      d.current_revision,d.lifecycle,d.created_at,d.updated_at,r.document from content_documents d
      join content_document_revisions r on r.page_id=d.id and r.revision=d.current_revision
      where d.workspace_id=${principal.workspaceId} and d.id=${pageId}
        and entity_access_allowed(d.workspace_id,d.id,${principal.principalId},'content.read')`
    const row = PageRowSchema.safeParse(rows[0])
    if (!row.success) throw new EntityNotFoundError(pageId)
    return toPage(row.data)
  }

  async children(
    principal: AuthenticatedPrincipal,
    parentPageId: string | null,
  ): Promise<readonly Page[]> {
    const rows = await this.#sql`select d.id,d.workspace_id,d.space_id,d.parent_page_id,d.title,
      d.current_revision,d.lifecycle,d.created_at,d.updated_at,r.document from content_documents d
      join content_document_revisions r on r.page_id=d.id and r.revision=d.current_revision
      where d.workspace_id=${principal.workspaceId}
        and d.parent_page_id is not distinct from ${parentPageId}
        and entity_access_allowed(d.workspace_id,d.id,${principal.principalId},'content.read')
      order by d.updated_at desc,d.id limit 500`
    return rows.map((row) => toPage(PageRowSchema.parse(row)))
  }

  async history(
    principal: AuthenticatedPrincipal,
    pageId: string,
  ): Promise<readonly PageHistoryEntry[]> {
    await this.page(principal, pageId)
    const rows = await this.#sql`select revision,actor_id,created_at,title,document
      from content_document_revisions where page_id=${pageId} order by revision desc limit 500`
    return rows.map((value) => {
      const row = HistoryRowSchema.parse(value)
      return {
        revision: row.revision,
        actorId: row.actor_id,
        createdAt: row.created_at.toISOString(),
        title: row.title,
        document: row.document,
      }
    })
  }

  async comments(
    principal: AuthenticatedPrincipal,
    pageId: string,
  ): Promise<readonly InlineComment[]> {
    await this.page(principal, pageId)
    const rows = await this.#sql`select id,page_id,block_id,author_id,body,created_at,resolved_at
      from inline_comments where page_id=${pageId} order by created_at,id limit 1000`
    return rows.map((value) => {
      const row = CommentRowSchema.parse(value)
      return {
        id: row.id,
        pageId: row.page_id,
        blockId: row.block_id,
        authorId: row.author_id,
        body: row.body,
        createdAt: row.created_at.toISOString(),
        resolvedAt: row.resolved_at?.toISOString() ?? null,
      }
    })
  }

  async backlinks(principal: AuthenticatedPrincipal, pageId: string): Promise<readonly object[]> {
    await this.page(principal, pageId)
    const rows = await this.#sql`select b.page_id as "pageId",b.block_id as "blockId",
      d.title,d.current_revision as revision from content_blocks b
      join content_documents d on d.id=b.page_id
      where b.entity_ref=${pageId} and entity_access_allowed(d.workspace_id,d.id,
        ${principal.principalId},'content.read') order by d.updated_at desc,d.id,b.position limit 1000`
    return [...rows]
  }

  async presence(principal: AuthenticatedPrincipal, pageId: string): Promise<readonly Presence[]> {
    await this.page(principal, pageId)
    const rows = await this.#sql`select principal_id,block_id,cursor_offset,expires_at
      from content_presence where page_id=${pageId} and expires_at>clock_timestamp()
      order by principal_id`
    return rows.map((value) => {
      const row = PresenceRowSchema.parse(value)
      return {
        principalId: row.principal_id,
        blockId: row.block_id,
        cursor: row.cursor_offset,
        expiresAt: row.expires_at.toISOString(),
      }
    })
  }

  async updatePresence(
    principal: AuthenticatedPrincipal,
    pageId: string,
    blockId: string | null,
    cursor: number | null,
  ): Promise<void> {
    await this.page(principal, pageId)
    if (blockId !== null) {
      const blocks = await this.#sql`select 1 from content_blocks
        where page_id=${pageId} and block_id=${blockId}`
      if (blocks.length !== 1) throw new EntityNotFoundError(blockId)
    }
    await this.#sql`insert into content_presence
      (workspace_id,page_id,principal_id,block_id,cursor_offset,expires_at)
      values (${principal.workspaceId},${pageId},${principal.principalId},${blockId},${cursor},
        clock_timestamp()+interval '30 seconds')
      on conflict (page_id,principal_id) do update set block_id=excluded.block_id,
        cursor_offset=excluded.cursor_offset,expires_at=excluded.expires_at`
  }

  async markdown(principal: AuthenticatedPrincipal, pageId: string): Promise<string> {
    return documentToMarkdown((await this.page(principal, pageId)).document)
  }
}

function toPage(row: z.infer<typeof PageRowSchema>): Page {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    spaceId: row.space_id,
    parentPageId: row.parent_page_id,
    title: row.title,
    revision: row.current_revision,
    lifecycle: row.lifecycle,
    document: row.document,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}
