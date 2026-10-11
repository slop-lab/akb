import type { TransactionSql } from "postgres"
import { CommandInvariantError } from "../../entities/errors.ts"

export type SearchDocumentKind = "project" | "work_item" | "comment"

export async function updateSearchDocument(
  transaction: TransactionSql,
  input: {
    readonly id: string
    readonly workspaceId: string
    readonly kind: SearchDocumentKind
    readonly revision: number
    readonly text: string
  },
): Promise<void> {
  await transaction`insert into search_documents(entity_id,workspace_id,kind,source_revision,document)
    values (${input.id},${input.workspaceId},${input.kind},${input.revision},to_tsvector('simple',${input.text}))
    on conflict(entity_id) do update set source_revision=excluded.source_revision,
      kind=excluded.kind,document=excluded.document,workspace_id=excluded.workspace_id`
}

export async function updateProjectSearchDocument(
  transaction: TransactionSql,
  workspaceId: string,
  entityId: string,
  revision: number,
): Promise<void> {
  const rows = await transaction<
    { readonly text: string }[]
  >`select concat_ws(' ',name,slug,summary) text
    from projects where workspace_id=${workspaceId} and id=${entityId}`
  const text = rows[0]?.text
  if (text === undefined) throw new CommandInvariantError("project_not_found")
  await updateSearchDocument(transaction, {
    id: entityId,
    workspaceId,
    kind: "project",
    revision,
    text,
  })
}

export async function updateWorkItemSearchDocument(
  transaction: TransactionSql,
  workspaceId: string,
  entityId: string,
  revision: number,
): Promise<void> {
  const rows = await transaction<
    { readonly text: string }[]
  >`select concat_ws(' ',w.title,pm.description) text
    from work_items w join work_item_pm pm on pm.work_item_id=w.id
    where w.workspace_id=${workspaceId} and w.id=${entityId}`
  const text = rows[0]?.text
  if (text === undefined) throw new CommandInvariantError("work_item_not_found")
  await updateSearchDocument(transaction, {
    id: entityId,
    workspaceId,
    kind: "work_item",
    revision,
    text,
  })
}

export async function updateCommentSearchDocument(
  transaction: TransactionSql,
  workspaceId: string,
  entityId: string,
  revision: number,
): Promise<void> {
  const rows = await transaction<{ readonly text: string }[]>`select body text from comments
    where workspace_id=${workspaceId} and id=${entityId}`
  const text = rows[0]?.text
  if (text === undefined) throw new CommandInvariantError("comment_not_found")
  await updateSearchDocument(transaction, {
    id: entityId,
    workspaceId,
    kind: "comment",
    revision,
    text,
  })
}
