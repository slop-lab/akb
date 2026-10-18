import { createHash } from "node:crypto"
import type { TransactionSql } from "postgres"
import { CommandInvariantError } from "../entities/errors.ts"
import type { MutationRecord } from "../entities/mutation-types.ts"
import { requireAccess, rowObject } from "./persistence.ts"
import type { PlanningCommandCall } from "./types.ts"

export function projectCommand(call: PlanningCommandCall, primaryEntityId: string) {
  return { ...call, primaryEntityId }
}

export function projectPlanningEntity(call: PlanningCommandCall, id: string, kind: string) {
  return {
    id,
    workspaceId: call.workspaceId,
    kind,
    spaceId: null,
    actorId: call.principal.principalId,
  }
}

export function stableProjectEntityId(call: PlanningCommandCall, kind: string): string {
  return `${kind}:${createHash("sha256").update(`${call.workspaceId}:${call.idempotencyKey}`).digest("hex")}`
}

export function projectBatch(primaryEntityId: string, record: MutationRecord) {
  return { primaryEntityId, records: [record] }
}

export function requiredProjectResource(value: string | null): string {
  if (value === null) throw new CommandInvariantError("planning_resource_required")
  return value
}

export async function requireProjectManage(
  transaction: TransactionSql,
  call: PlanningCommandCall,
  projectId: string,
): Promise<void> {
  await requireAccess(transaction, {
    workspaceId: call.workspaceId,
    principalId: call.principal.principalId,
    entityId: projectId,
    permission: "project.manage",
  })
}

export async function milestoneSnapshot(transaction: TransactionSql, id: string) {
  const rows =
    await transaction`select id,project_id "projectId",position,name,description,target_date::text "targetDate",revision from milestones where id=${id}`
  return rowObject(rows[0])
}

export async function moduleSnapshot(transaction: TransactionSql, id: string) {
  const rows =
    await transaction`select id,project_id "projectId",name,description,owner_id "ownerId",start_date::text "startDate",target_date::text "targetDate",status,revision from modules where id=${id}`
  return rowObject(rows[0])
}

export async function projectUpdateSnapshot(transaction: TransactionSql, id: string) {
  const rows =
    await transaction`select id,project_id "projectId",health,body,author_id "authorId",published_at "publishedAt",total,completed,estimated,blocked,metric_mode "metricMode",revision from project_updates where id=${id}`
  return rowObject(rows[0])
}

export async function notifyProjectMembers(
  transaction: TransactionSql,
  input: {
    readonly call: PlanningCommandCall
    readonly projectId: string
    readonly sourceEntityId: string
    readonly eventId: string
  },
): Promise<void> {
  const { call, projectId, sourceEntityId, eventId } = input
  await transaction`insert into notifications
    (workspace_id,recipient_id,source_event_id,source_entity_id,deduplication_key,payload)
    select ${call.workspaceId},membership.principal_id,${eventId},${sourceEntityId},
      ${eventId}::text || ':' || membership.principal_id,
      jsonb_build_object('type','project_update','projectId',${projectId}::text,
        'updateId',${sourceEntityId}::text)
    from workspace_memberships membership
    where membership.workspace_id=${call.workspaceId} and membership.status='active'
      and entity_access_allowed(${call.workspaceId},${projectId},membership.principal_id,'project.read')
      and coalesce((select preference.in_app from notification_preferences preference
        where preference.workspace_id=${call.workspaceId} and preference.principal_id=membership.principal_id
          and preference.event_type='project_update'),true)
    on conflict do nothing`
}
