import type { TransactionSql } from "postgres"
import { EntityNotFoundError } from "../entities/errors.ts"
import type { MutationRecord } from "../entities/mutation-types.ts"
import {
  appendLegacyEvent,
  appendLegacyRevision,
  workRecord,
  workSnapshot,
} from "../pm/commands/work-item-command-persistence.ts"
import { updateWorkItemSearchDocument } from "../pm/projections/search-document.ts"
import type { PlanningCommandCall } from "./types.ts"

type WorkScope = {
  readonly workspace_id: string
  readonly space_id: string
  readonly project_id: string | null
}

type PlanningAssignment = {
  readonly cycleId: string | null
  readonly milestoneId: string | null
  readonly moduleIds: readonly string[]
}

export async function validateAssignments(
  transaction: TransactionSql,
  input: {
    readonly call: PlanningCommandCall
    readonly work: WorkScope
    readonly assignment: PlanningAssignment
  },
): Promise<void> {
  const { call, work, assignment } = input
  if (assignment.cycleId !== null) {
    const rows = await transaction`select 1 from cycles where id=${assignment.cycleId}
      and workspace_id=${work.workspace_id} and space_id=${work.space_id}
      and entity_access_allowed(workspace_id,id,${call.principal.principalId},'work.read')`
    if (rows.length !== 1) throw new EntityNotFoundError(assignment.cycleId)
  }
  if (assignment.milestoneId !== null) {
    const rows = await transaction`select 1 from milestones where id=${assignment.milestoneId}
      and workspace_id=${work.workspace_id} and project_id=${work.project_id}
      and entity_access_allowed(workspace_id,id,${call.principal.principalId},'project.read')`
    if (rows.length !== 1) throw new EntityNotFoundError(assignment.milestoneId)
  }
  const moduleIds = [...new Set(assignment.moduleIds)]
  if (moduleIds.length === 0) return
  if (work.project_id === null) throw new EntityNotFoundError(moduleIds[0] ?? "module")
  const rows = await transaction<{ readonly id: string }[]>`
    select id from modules where workspace_id=${work.workspace_id} and project_id=${work.project_id}
      and id=any(${transaction.array(moduleIds)})
      and entity_access_allowed(workspace_id,id,${call.principal.principalId},'project.read')`
  if (rows.length !== moduleIds.length) throw new EntityNotFoundError(moduleIds[0] ?? "module")
}

export async function planningWorkRecord(
  transaction: TransactionSql,
  input: {
    readonly call: PlanningCommandCall
    readonly workId: string
    readonly revision: number
  },
): Promise<MutationRecord> {
  const { call, workId, revision } = input
  await transaction`update work_items set revision=${revision},updated_at=clock_timestamp()
    where id=${workId}`
  await updateWorkItemSearchDocument(transaction, call.workspaceId, workId, revision)
  await appendLegacyRevision(transaction, workId)
  return workRecord(
    workId,
    revision,
    "entity.updated",
    await workSnapshot(transaction, workId),
    async (eventId, occurredAt) => {
      await appendLegacyEvent(transaction, call, workId, revision, eventId, occurredAt, [])
    },
  )
}
