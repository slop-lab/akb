import { createHash } from "node:crypto"
import { z } from "zod"
import {
  ArchivePayloadSchema,
  CommentCreatePayloadSchema,
  CommentUpdatePayloadSchema,
  RelationCreatePayloadSchema,
  RelationUpdatePayloadSchema,
} from "../../contracts/r4/command-payloads.ts"
import { CommandInvariantError, EntityNotFoundError } from "../../entities/errors.ts"
import type { EntityMutationEngine } from "../../entities/mutation-engine.ts"
import type { MutationResult } from "../../entities/mutation-types.ts"
import { updateCommentSearchDocument } from "../projections/search-document.ts"
import {
  commentRecord,
  commentSnapshot,
  ensureThread,
  relationRecord,
  relationSnapshot,
  requireEndpoint,
  requireParentAllowed,
} from "./collaboration-command-persistence.ts"
import { insertEntity, newEntityId, requireEntityRead } from "./helpers.ts"
import type { CommandCall } from "./types.ts"

export class CollaborationCommandService {
  readonly engine: EntityMutationEngine

  constructor(engine: EntityMutationEngine) {
    this.engine = engine
  }

  execute(call: CommandCall): Promise<MutationResult> {
    switch (call.action) {
      case "relation.create":
        return this.#createRelation(call)
      case "relation.update":
        return this.#updateRelation(call)
      case "relation.archive":
        return this.#archiveRelation(call)
      case "comment.create":
        return this.#createComment(call)
      case "comment.update":
        return this.#updateComment(call)
      case "comment.archive":
        return this.#archiveComment(call)
      default:
        throw new CommandInvariantError("unsupported_collaboration_action")
    }
  }

  #createRelation(call: CommandCall): Promise<MutationResult> {
    const payload = RelationCreatePayloadSchema.parse(call.payload)
    const entityId = newEntityId("relation")
    return this.engine.mutate(
      mutationInput(call, "relation.manage", null),
      async (transaction, revision) => {
        await requireEntityRead(transaction, endpointReference(call, payload.fromEntityId))
        await requireEntityRead(transaction, endpointReference(call, payload.toEntityId))
        if (payload.relationType === "parent_of") {
          await requireParentAllowed(transaction, payload.fromEntityId, payload.toEntityId, null)
        }
        await insertEntity(transaction, {
          id: entityId,
          workspaceId: call.workspaceId,
          kind: "relation",
          scopeSpaceId: null,
          actorId: call.principal.principalId,
        })
        await transaction`insert into relations
          (id,workspace_id,from_entity_id,relation_type,to_entity_id,revision,asserted_by,valid_from)
          values (${entityId},${call.workspaceId},${payload.fromEntityId},${payload.relationType},
            ${payload.toEntityId},${revision},${call.principal.principalId},clock_timestamp())`
        return relationRecord(
          entityId,
          revision,
          "relation.created",
          await relationSnapshot(transaction, entityId),
        )
      },
    )
  }

  #updateRelation(call: CommandCall): Promise<MutationResult> {
    const payload = RelationUpdatePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "relation.manage", entityId),
      async (transaction, revision) => {
        const endpoints =
          await transaction`select from_entity_id,to_entity_id from relations where id=${entityId}
            and valid_to is null`
        const row = z
          .strictObject({ from_entity_id: z.string(), to_entity_id: z.string() })
          .parse(endpoints[0])
        if (payload.relationType === "related_to" && row.from_entity_id >= row.to_entity_id) {
          throw new CommandInvariantError("related_endpoints_not_canonical")
        }
        if (payload.relationType === "parent_of") {
          await requireParentAllowed(transaction, row.from_entity_id, row.to_entity_id, entityId)
        }
        await requireEndpoint(transaction, call, row.from_entity_id)
        await requireEndpoint(transaction, call, row.to_entity_id)
        await transaction`update relations set relation_type=${payload.relationType},revision=${revision}
          where id=${entityId}`
        return relationRecord(
          entityId,
          revision,
          "relation.updated",
          await relationSnapshot(transaction, entityId),
        )
      },
    )
  }

  #archiveRelation(call: CommandCall): Promise<MutationResult> {
    ArchivePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "relation.manage", entityId),
      async (transaction, revision) => {
        const endpoints =
          await transaction`select from_entity_id,to_entity_id from relations where id=${entityId}
            and valid_to is null`
        const row = z
          .strictObject({ from_entity_id: z.string(), to_entity_id: z.string() })
          .parse(endpoints[0])
        await requireEndpoint(transaction, call, row.from_entity_id)
        await requireEndpoint(transaction, call, row.to_entity_id)
        await transaction`update relations set valid_to=${call.restoredAt === undefined ? transaction`clock_timestamp()` : transaction`${call.restoredAt}::timestamptz`},revision=${revision} where id=${entityId}`
        return relationRecord(
          entityId,
          revision,
          "relation.archived",
          await relationSnapshot(transaction, entityId),
        )
      },
    )
  }

  #createComment(call: CommandCall): Promise<MutationResult> {
    const payload = CommentCreatePayloadSchema.parse(call.payload)
    const subjectId = required(call.parentId)
    const entityId = newEntityId("comment")
    return this.engine.mutate(
      mutationInput(call, "comment.create", null),
      async (transaction, revision) => {
        const scopeSpaceId = await requireEntityRead(
          transaction,
          endpointReference(call, subjectId),
        )
        const threadId = `thread:${createHash("sha256").update(`${call.workspaceId}:${subjectId}`).digest("hex")}`
        await ensureThread(transaction, call, threadId, subjectId, scopeSpaceId)
        await insertEntity(transaction, {
          id: entityId,
          workspaceId: call.workspaceId,
          kind: "comment",
          scopeSpaceId,
          actorId: call.principal.principalId,
        })
        await transaction`insert into comments
          (id,workspace_id,thread_id,author_id,body,revision,created_at,updated_at)
          values (${entityId},${call.workspaceId},${threadId},${call.principal.principalId},
            ${payload.body},${revision},clock_timestamp(),clock_timestamp())`
        await updateCommentSearchDocument(transaction, call.workspaceId, entityId, revision)
        return commentRecord(
          entityId,
          revision,
          "comment.created",
          await commentSnapshot(transaction, entityId),
        )
      },
    )
  }

  #updateComment(call: CommandCall): Promise<MutationResult> {
    const payload = CommentUpdatePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "comment.update", entityId),
      async (transaction, revision) => {
        const subjects = await transaction<{ readonly subject_entity_id: string }[]>`
          select t.subject_entity_id from comments c join threads t on t.id=c.thread_id where c.id=${entityId}`
        const subjectId = subjects[0]?.subject_entity_id
        if (subjectId === undefined) throw new EntityNotFoundError(entityId)
        await requireEndpoint(transaction, call, subjectId)
        await transaction`update comments set body=${payload.body},revision=${revision},
          updated_at=clock_timestamp() where id=${entityId}`
        await updateCommentSearchDocument(transaction, call.workspaceId, entityId, revision)
        return commentRecord(
          entityId,
          revision,
          "comment.updated",
          await commentSnapshot(transaction, entityId),
        )
      },
    )
  }

  #archiveComment(call: CommandCall): Promise<MutationResult> {
    ArchivePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "comment.update", entityId),
      async (transaction, revision) => {
        const subjects = await transaction<{ readonly subject_entity_id: string }[]>`
          select t.subject_entity_id from comments c join threads t on t.id=c.thread_id where c.id=${entityId}`
        const subjectId = subjects[0]?.subject_entity_id
        if (subjectId === undefined) throw new EntityNotFoundError(entityId)
        await requireEndpoint(transaction, call, subjectId)
        await transaction`update comments set archived_at=${call.restoredAt === undefined ? transaction`clock_timestamp()` : transaction`${call.restoredAt}::timestamptz`},revision=${revision},
          updated_at=clock_timestamp() where id=${entityId}`
        await updateCommentSearchDocument(transaction, call.workspaceId, entityId, revision)
        return commentRecord(
          entityId,
          revision,
          "entity.archived",
          await commentSnapshot(transaction, entityId),
        )
      },
    )
  }
}

function mutationInput(
  call: CommandCall,
  permission: "relation.manage" | "comment.create" | "comment.update",
  targetEntityId: string | null,
) {
  return { ...call, permission, targetEntityId }
}

function required(value: string | null): string {
  if (value === null) throw new CommandInvariantError("resource_id_required")
  return value
}

function endpointReference(call: CommandCall, entityId: string) {
  return {
    workspaceId: call.workspaceId,
    principalId: call.principal.principalId,
    entityId,
    kinds: ["project", "work_item", "label", "workflow_state", "space"],
  }
}
