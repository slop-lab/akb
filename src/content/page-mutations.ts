import type { TransactionSql } from "postgres"
import type { CreatePage, PatchPage } from "../contracts/content/requests.ts"
import { EntityNotFoundError } from "../entities/errors.ts"
import type { MutationRecord } from "../entities/mutation-types.ts"
import { insertEntity } from "../entities/registry.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import {
  type PageState,
  pageSnapshot,
  readPageState,
  replaceBlockIndex,
  replacePageDependency,
  requireValidPageParent,
} from "./postgres-support.ts"

type PageMutation = {
  readonly transaction: TransactionSql
  readonly principal: AuthenticatedPrincipal
  readonly pageId: string
  readonly revision: number
}

export async function createPageRecord(
  context: PageMutation,
  input: CreatePage,
): Promise<MutationRecord> {
  const state = { title: input.title, parentPageId: input.parentPageId, document: input.document }
  if (input.spaceId !== null) {
    const access = await context.transaction<{ readonly allowed: boolean }[]>`select
      entity_access_allowed(${context.principal.workspaceId},
        stable_space_entity_id(${context.principal.workspaceId},${input.spaceId}),
        ${context.principal.principalId},'content.manage') allowed`
    if (access[0]?.allowed !== true) throw new EntityNotFoundError(input.spaceId)
  }
  if (state.parentPageId !== null) {
    await requireValidPageParent(
      context.transaction,
      context.principal,
      context.pageId,
      state.parentPageId,
    )
  }
  await insertEntity(context.transaction, {
    id: context.pageId,
    workspaceId: context.principal.workspaceId,
    kind: "page",
    scopeSpaceId: input.spaceId,
    actorId: context.principal.principalId,
  })
  await context.transaction`insert into content_documents
    (id,workspace_id,space_id,parent_page_id,title,current_revision)
    values (${context.pageId},${context.principal.workspaceId},${input.spaceId},
      ${state.parentPageId},${state.title},${context.revision})`
  await replacePageDependency(context.transaction, context.pageId, state.parentPageId)
  await replaceBlockIndex(context.transaction, context.pageId, state.document)
  return pageRecord(context, state, "entity.created", "active")
}

export async function patchPageRecord(
  context: PageMutation,
  input: PatchPage,
): Promise<MutationRecord> {
  const current = await readPageState(context.transaction, context.pageId)
  const state: PageState = {
    title: input.title ?? current.title,
    parentPageId: input.parentPageId === undefined ? current.parentPageId : input.parentPageId,
    document: input.document ?? current.document,
  }
  if (state.parentPageId !== null) {
    await requireValidPageParent(
      context.transaction,
      context.principal,
      context.pageId,
      state.parentPageId,
    )
  }
  await context.transaction`update content_documents set title=${state.title},
    parent_page_id=${state.parentPageId},current_revision=${context.revision},updated_at=clock_timestamp()
    where id=${context.pageId}`
  await replacePageDependency(context.transaction, context.pageId, state.parentPageId)
  await replaceBlockIndex(context.transaction, context.pageId, state.document)
  return pageRecord(context, state, "entity.updated", "active")
}

export async function restorePageRecord(
  context: PageMutation,
  sourceRevision: number,
): Promise<MutationRecord> {
  const state = await readPageState(context.transaction, context.pageId, sourceRevision)
  if (state.parentPageId !== null) {
    await requireValidPageParent(
      context.transaction,
      context.principal,
      context.pageId,
      state.parentPageId,
    )
  }
  await context.transaction`update content_documents set title=${state.title},
    parent_page_id=${state.parentPageId},current_revision=${context.revision},lifecycle='active',
    archived_at=null,updated_at=clock_timestamp() where id=${context.pageId}`
  await replacePageDependency(context.transaction, context.pageId, state.parentPageId)
  await replaceBlockIndex(context.transaction, context.pageId, state.document)
  return pageRecord(context, state, "entity.restored", "active")
}

export async function archivePageRecord(context: PageMutation): Promise<MutationRecord> {
  const state = await readPageState(context.transaction, context.pageId)
  await context.transaction`update content_documents set current_revision=${context.revision},
    lifecycle='archived',archived_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=${context.pageId}`
  return pageRecord(context, state, "entity.archived", "archived")
}

function pageRecord(
  context: PageMutation,
  state: PageState,
  eventType: MutationRecord["eventType"],
  lifecycle: "active" | "archived",
): MutationRecord {
  const snapshot = pageSnapshot(
    context.pageId,
    context.principal.workspaceId,
    context.revision,
    state,
    lifecycle,
  )
  return {
    entityId: context.pageId,
    kind: "page",
    revision: context.revision,
    schemaVersion: "page.content.v1",
    eventType,
    snapshot,
    eventData: { id: context.pageId, lifecycle },
    result: snapshot,
    postEvent: async (_eventId, occurredAt) => {
      await context.transaction`insert into content_document_revisions
        (page_id,revision,title,parent_page_id,document,actor_id,created_at,digest)
        values (${context.pageId},${context.revision},${state.title},${state.parentPageId},
          ${context.transaction.json(state.document)},${context.principal.principalId},${occurredAt},
          encode(public.digest(convert_to(${JSON.stringify(state.document)},'utf8'),'sha256'),'hex'))`
    },
  }
}
