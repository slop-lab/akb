import type { TransactionSql } from "postgres"
import { z } from "zod"
import { CommandInvariantError } from "../../entities/errors.ts"
import type { JsonObject, MutationRecord } from "../../entities/mutation-types.ts"
import { insertEntity, requireEntityRead } from "./helpers.ts"
import type { CommandCall } from "./types.ts"

const SnapshotRowSchema = z.strictObject({ snapshot: z.record(z.string(), z.unknown()) })
export async function requireEndpoint(
  transaction: TransactionSql,
  call: CommandCall,
  entityId: string,
): Promise<string | null> {
  return requireEntityRead(transaction, {
    workspaceId: call.workspaceId,
    principalId: call.principal.principalId,
    entityId,
    kinds: ["project", "work_item", "label", "workflow_state", "space"],
  })
}

export async function requireParentAllowed(
  transaction: TransactionSql,
  fromId: string,
  toId: string,
  excludedRelationId: string | null,
): Promise<void> {
  const rows = await transaction`select 1 where
    exists (select 1 from relations where to_entity_id=${toId} and relation_type='parent_of'
      and valid_to is null and (${excludedRelationId}::text is null or id<>${excludedRelationId}))
    or exists (with recursive descendants(id) as (select ${toId}::text union
      select r.to_entity_id from relations r join descendants d on r.from_entity_id=d.id
      where r.relation_type='parent_of' and r.valid_to is null
        and (${excludedRelationId}::text is null or r.id<>${excludedRelationId}))
      select 1 from descendants where id=${fromId})`
  if (rows.length === 1) throw new CommandInvariantError("parent_relation_invalid")
}

export async function ensureThread(
  transaction: TransactionSql,
  call: CommandCall,
  threadId: string,
  subjectId: string,
  scopeSpaceId: string | null,
): Promise<void> {
  const rows = await transaction`select id from threads where workspace_id=${call.workspaceId}
    and subject_entity_id=${subjectId}`
  if (rows.length > 0) return
  await insertEntity(transaction, {
    id: threadId,
    workspaceId: call.workspaceId,
    kind: "thread",
    scopeSpaceId,
    actorId: call.principal.principalId,
  })
  await transaction`insert into threads values (${threadId},${call.workspaceId},${subjectId},1)`
  const snapshot = { id: threadId, subjectId }
  await transaction`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    values (${threadId},1,'thread.r4.v1',${transaction.json(snapshot)},${call.principal.principalId},clock_timestamp(),
      encode(public.digest(convert_to(${JSON.stringify(snapshot)},'utf8'),'sha256'),'hex'))`
}

export async function relationSnapshot(
  transaction: TransactionSql,
  id: string,
): Promise<JsonObject> {
  const rows = await transaction`select to_jsonb(r) snapshot from relations r where id=${id}`
  return SnapshotRowSchema.parse(rows[0]).snapshot
}

export async function commentSnapshot(
  transaction: TransactionSql,
  id: string,
): Promise<JsonObject> {
  const rows = await transaction`select to_jsonb(c) snapshot from comments c where id=${id}`
  return SnapshotRowSchema.parse(rows[0]).snapshot
}

function record(
  kind: "relation" | "comment",
  entityId: string,
  revision: number,
  eventType: MutationRecord["eventType"],
  snapshot: JsonObject,
): MutationRecord {
  return {
    entityId,
    kind,
    revision,
    schemaVersion: `${kind}.r4.v1`,
    eventType,
    snapshot,
    eventData: { id: entityId },
    result: { id: entityId },
  }
}

export const relationRecord = record.bind(undefined, "relation")
export const commentRecord = record.bind(undefined, "comment")
