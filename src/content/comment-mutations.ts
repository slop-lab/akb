import type { TransactionSql } from "postgres"
import type { CreateInlineComment } from "../contracts/content/requests.ts"
import type { MutationRecord } from "../entities/mutation-types.ts"
import { insertEntity, linkEntityAccessDependency } from "../entities/registry.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { ContentInvariantError } from "./errors.ts"
import { requirePageDependency } from "./postgres-support.ts"

export async function createInlineCommentRecord(input: {
  readonly transaction: TransactionSql
  readonly principal: AuthenticatedPrincipal
  readonly pageId: string
  readonly commentId: string
  readonly revision: number
  readonly comment: CreateInlineComment
}): Promise<MutationRecord> {
  await requirePageDependency(input.transaction, input.principal, input.pageId)
  const anchors = await input.transaction`select 1 from content_blocks
    where page_id=${input.pageId} and block_id=${input.comment.blockId}`
  if (anchors.length !== 1) throw new ContentInvariantError("comment_block_not_found")
  await insertEntity(input.transaction, {
    id: input.commentId,
    workspaceId: input.principal.workspaceId,
    kind: "inline_comment",
    scopeSpaceId: null,
    actorId: input.principal.principalId,
  })
  await linkEntityAccessDependency(input.transaction, input.commentId, input.pageId)
  await input.transaction`insert into inline_comments
    (id,workspace_id,page_id,block_id,author_id,body,revision)
    values (${input.commentId},${input.principal.workspaceId},${input.pageId},
      ${input.comment.blockId},${input.principal.principalId},${input.comment.body},${input.revision})`
  const snapshot = {
    id: input.commentId,
    pageId: input.pageId,
    blockId: input.comment.blockId,
    authorId: input.principal.principalId,
    body: input.comment.body,
    revision: input.revision,
  }
  return {
    entityId: input.commentId,
    kind: "inline_comment",
    revision: input.revision,
    schemaVersion: "inline-comment.content.v1",
    eventType: "comment.created",
    snapshot,
    eventData: { pageId: input.pageId, blockId: input.comment.blockId },
    result: snapshot,
  }
}
