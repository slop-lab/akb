import type { TransactionSql } from "postgres"
import { z } from "zod"
import { CommandInvariantError, EntityNotFoundError } from "../../entities/errors.ts"
import type { JsonObject, MutationRecord } from "../../entities/mutation-types.ts"
import {
  requireActiveHuman,
  requireEntityRead,
  requireSpaceAccess,
  stableEntityId,
} from "./helpers.ts"
import type { CommandCall } from "./types.ts"

const SnapshotRowSchema = z.strictObject({ snapshot: z.record(z.string(), z.unknown()) })
const StateRowSchema = z.strictObject({
  category: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]),
})

export async function requireAssignmentAccess(
  transaction: TransactionSql,
  call: CommandCall,
  input: { readonly spaceId: string; readonly entityId?: string },
): Promise<void> {
  await requireSpaceAccess(transaction, {
    principal: call.principal,
    spaceId: input.spaceId,
    permission: "work.assign",
  })
  if (input.entityId === undefined) return
  const rows = await transaction`select 1 where entity_access_allowed(${call.workspaceId},
    ${input.entityId},${call.principal.principalId},'work.assign')`
  if (rows.length !== 1) throw new EntityNotFoundError(input.entityId)
}

export async function validateAssignment(
  transaction: TransactionSql,
  call: CommandCall,
  ownerId: string,
  spaceId: string,
): Promise<void> {
  await requireActiveHuman(transaction, call.workspaceId, ownerId)
  const spaceEntityId = stableEntityId("space", call.workspaceId, spaceId)
  const rows = await transaction`select 1 where entity_access_allowed(${call.workspaceId},
    ${spaceEntityId},${ownerId},'work.read')`
  if (rows.length !== 1) throw new EntityNotFoundError(spaceEntityId)
}

export async function requireState(
  transaction: TransactionSql,
  call: CommandCall,
  spaceId: string,
  stateId: string,
) {
  const rows =
    await transaction`select category from workflow_states where workspace_id=${call.workspaceId}
    and space_id=${spaceId} and id=${stateId} and active`
  if (rows[0] === undefined) throw new EntityNotFoundError(stateId)
  await requireEntityRead(transaction, {
    workspaceId: call.workspaceId,
    principalId: call.principal.principalId,
    entityId: stateId,
    kinds: ["workflow_state"],
    scopeSpaceId: spaceId,
  })
  return StateRowSchema.parse(rows[0]).category
}

export async function requireProjectAndLabels(
  transaction: TransactionSql,
  call: CommandCall,
  spaceId: string,
  projectId: string | null | undefined,
  labels: readonly string[] | undefined,
): Promise<void> {
  if (projectId !== undefined && projectId !== null) {
    const rows =
      await transaction`select 1 from project_spaces ps join projects p on p.id=ps.project_id
      where ps.workspace_id=${call.workspaceId} and ps.space_id=${spaceId} and ps.project_id=${projectId}
        and p.archived_at is null`
    if (rows.length !== 1) throw new CommandInvariantError("project_must_participate_in_space")
    await requireEntityRead(transaction, {
      workspaceId: call.workspaceId,
      principalId: call.principal.principalId,
      entityId: projectId,
      kinds: ["project"],
    })
  }
  if (labels !== undefined) {
    const unique = [...new Set(labels)]
    const rows = await transaction<
      { readonly count: number }[]
    >`select count(*)::integer count from labels
      where workspace_id=${call.workspaceId} and space_id=${spaceId} and archived_at is null
        and id=any(${transaction.array(unique)})`
    if ((rows[0]?.count ?? 0) !== unique.length) {
      throw new CommandInvariantError("labels_must_belong_to_space")
    }
    for (const labelId of unique) {
      await requireEntityRead(transaction, {
        workspaceId: call.workspaceId,
        principalId: call.principal.principalId,
        entityId: labelId,
        kinds: ["label"],
        scopeSpaceId: spaceId,
      })
    }
  }
}

export async function replaceLabels(
  transaction: TransactionSql,
  itemId: string,
  labels: readonly string[],
): Promise<void> {
  await transaction`delete from work_item_labels where work_item_id=${itemId}`
  for (const labelId of new Set(labels)) {
    await transaction`insert into work_item_labels values (${itemId},${labelId})`
  }
}

export async function appendLegacyRevision(
  transaction: TransactionSql,
  entityId: string,
): Promise<void> {
  await transaction`insert into work_item_revisions
    (work_item_id,workspace_id,space_id,title,state,accountable_owner_id,revision,created_at,updated_at)
    select id,workspace_id,space_id,title,state,accountable_owner_id,revision,created_at,updated_at
    from work_items where id=${entityId}`
}

export async function appendLegacyEvent(
  transaction: TransactionSql,
  call: CommandCall,
  entityId: string,
  revision: number,
  eventId: string,
  occurredAt: string,
  changedFields: readonly string[] | null,
): Promise<void> {
  const rows = await transaction<{ readonly sequence: number }[]>`
    insert into workspace_event_sequences values (${call.workspaceId},1)
    on conflict (workspace_id) do update set last_sequence=workspace_event_sequences.last_sequence+1
    returning last_sequence::integer sequence`
  const sequence = rows[0]?.sequence
  if (sequence === undefined) throw new CommandInvariantError("legacy_event_sequence_missing")
  await transaction`insert into domain_events
    (id,workspace_id,space_id,sequence,event_type,occurred_at,actor_id,subject_id,subject_revision,changed_fields)
    select ${eventId},workspace_id,space_id,${sequence},
      ${revision === 1 ? "work_item.created" : "work_item.updated"},${occurredAt},
      ${call.principal.principalId},id,revision,${changedFields === null ? null : transaction.array([...changedFields])}
    from work_items where id=${entityId}`
}

export async function workSnapshot(
  transaction: TransactionSql,
  entityId: string,
): Promise<JsonObject> {
  const rows =
    await transaction`select to_jsonb(w) || to_jsonb(pm) || jsonb_build_object('labelIds',
    coalesce((select jsonb_agg(label_id order by label_id) from work_item_labels where work_item_id=w.id),'[]')) snapshot
    from work_items w join work_item_pm pm on pm.work_item_id=w.id where w.id=${entityId}`
  return SnapshotRowSchema.parse(rows[0]).snapshot
}

export function workRecord(
  entityId: string,
  revision: number,
  eventType: MutationRecord["eventType"],
  snapshot: JsonObject,
  postEvent: (eventId: string, occurredAt: string) => Promise<void>,
): MutationRecord {
  return {
    entityId,
    kind: "work_item",
    revision,
    schemaVersion: "work-item.r4.v1",
    eventType,
    snapshot,
    eventData: { id: entityId },
    result: { id: entityId },
    postEvent,
  }
}
