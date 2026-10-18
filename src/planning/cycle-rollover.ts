import type { TransactionSql } from "postgres"
import { CommandInvariantError } from "../entities/errors.ts"
import { rowObject } from "./persistence.ts"

export async function cycleSnapshot(transaction: TransactionSql, id: string) {
  const rows =
    await transaction`select id,"workspace_id" as "workspaceId","space_id" as "spaceId",sequence,name,
    start_date::text "startDate",end_date::text "endDate",status,goal,capacity_hint "capacityHint",
    rollover_policy "rolloverPolicy",revision from cycles where id=${id}`
  return rowObject(rows[0])
}

export async function requireSameCycleSpace(
  transaction: TransactionSql,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const rows = await transaction`select 1 from cycles source join cycles target
    on target.workspace_id=source.workspace_id and target.space_id=source.space_id
    where source.id=${sourceId} and target.id=${targetId} and source.status='active'
      and target.status='upcoming' for update of source,target`
  if (rows.length !== 1) throw new CommandInvariantError("cycle_rollover_target_invalid")
}

export async function rolloverWork(
  transaction: TransactionSql,
  input: {
    readonly sourceId: string
    readonly targetId: string
    readonly workId: string
    readonly actorId: string
  },
): Promise<void> {
  const { sourceId, targetId, workId, actorId } = input
  const rows = await transaction`update work_item_planning planning set cycle_id=${targetId}
    from work_item_pm pm join workflow_states state on state.id=pm.workflow_state_id
    where planning.work_item_id=${workId} and planning.cycle_id=${sourceId}
      and pm.work_item_id=planning.work_item_id and state.category not in ('completed','canceled')
    returning planning.work_item_id`
  if (rows.length !== 1) throw new CommandInvariantError("cycle_rollover_work_invalid")
  await transaction`insert into cycle_scope_changes
    (workspace_id,cycle_id,work_item_id,change_kind,occurred_at,actor_id)
    select workspace_id,${sourceId},work_item_id,'carried_over',clock_timestamp(),${actorId}
    from work_item_planning where work_item_id=${workId}`
}

export async function captureCycleMetrics(
  transaction: TransactionSql,
  input: { readonly cycleId: string; readonly revision: number; readonly carryOver: number },
): Promise<void> {
  const { cycleId, revision, carryOver } = input
  await transaction`insert into cycle_metric_snapshots
    (cycle_id,revision,captured_at,committed_count,added_count,removed_count,completed_count,
     committed_estimate,completed_estimate,carry_over_count)
    select ${cycleId},${revision},clock_timestamp(),count(*)::integer,
      count(*) filter (where change_kind='added')::integer,
      count(*) filter (where change_kind='removed')::integer,0,0,0,${carryOver}
    from cycle_scope_changes where cycle_id=${cycleId}`
}
