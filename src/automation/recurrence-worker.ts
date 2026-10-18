import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import { RecurrenceScheduleSchema } from "../contracts/automation/index.ts"
import {
  CommandIdempotencyConflictError,
  CommandInvariantError,
  EntityNotFoundError,
  EntityRevisionConflictError,
} from "../entities/errors.ts"
import { R4CommandService } from "../pm/commands/service.ts"
import { resolveAutomationPrincipal } from "./principal.ts"
import { nextOccurrence } from "./schedule.ts"

type RuleRow = {
  readonly id: string
  readonly workspace_id: string
  readonly template_revision: number
  readonly target_space_id: string
  readonly schedule: unknown
  readonly timezone: string
  readonly incomplete_policy: "skip" | "create" | "merge"
  readonly title: string
  readonly next_run_at: Date
  readonly created_by: string
}

export async function processRecurrences(sql: Sql, now: Date, limit: number): Promise<number> {
  let processed = 0
  for (let index = 0; index < limit; index += 1) {
    const found = await processNextRecurrence(sql, now)
    if (!found) break
    processed += 1
  }
  return processed
}

async function processNextRecurrence(sql: Sql, now: Date): Promise<boolean> {
  let ruleId: string | undefined
  try {
    return await sql.begin(async (transaction) => {
      const rules = await transaction<RuleRow[]>`select id,workspace_id,template_revision,
        target_space_id,schedule,timezone,incomplete_policy,title,next_run_at,created_by
        from recurrence_rules where enabled and next_run_at<=${now.toISOString()}
        order by next_run_at,id for update skip locked limit 1`
      const rule = rules[0]
      if (rule === undefined) return false
      ruleId = rule.id
      await materialize(transaction, rule)
      return true
    })
  } catch (error) {
    if (ruleId === undefined || !isRuleFailure(error)) throw error
    await sql`update recurrence_rules set enabled=false where id=${ruleId}`
    return true
  }
}

async function materialize(transaction: TransactionSql, rule: RuleRow): Promise<void> {
  const scheduledFor = rule.next_run_at.toISOString()
  const existing = await transaction`select 1 from recurrence_occurrences
    where rule_id=${rule.id} and scheduled_for=${scheduledFor}`
  const schedule = RecurrenceScheduleSchema.parse(rule.schedule)
  const next = nextOccurrence(schedule, rule.timezone, rule.next_run_at).toISOString()
  if (existing.length === 1) {
    await transaction`update recurrence_rules set next_run_at=${next} where id=${rule.id}`
    return
  }
  const incomplete = await transaction<
    { readonly id: string }[]
  >`select work.id from recurrence_occurrences occurrence
    join work_items work on work.id=occurrence.work_item_id
    where occurrence.rule_id=${rule.id} and work.state not in ('completed','canceled')
    order by occurrence.scheduled_for desc limit 1`
  const priorId = incomplete[0]?.id
  if (priorId !== undefined && rule.incomplete_policy !== "create") {
    await transaction`insert into recurrence_occurrences
      (rule_id,scheduled_for,template_revision,outcome,work_item_id,created_at)
      values (${rule.id},${scheduledFor},${rule.template_revision},
        ${rule.incomplete_policy === "skip" ? "skipped" : "merged"},
        ${rule.incomplete_policy === "skip" ? null : priorId},clock_timestamp())`
    await transaction`update recurrence_rules set next_run_at=${next} where id=${rule.id}`
    return
  }
  const stateRows = await transaction<{ readonly id: string }[]>`select id from workflow_states
    where workspace_id=${rule.workspace_id} and space_id=${rule.target_space_id} and active and is_default`
  const stateId = stateRows[0]?.id
  if (stateId === undefined) throw new RecurrenceWorkerError("default workflow state is missing")
  const principal = await resolveAutomationPrincipal(
    transaction,
    rule.workspace_id,
    rule.created_by,
  )
  const key = `recurrence:${rule.id}:${scheduledFor}`
  const created = await new R4CommandService(transaction).execute({
    workspaceId: rule.workspace_id,
    principal,
    commandId: key,
    idempotencyKey: key,
    baseRevision: null,
    action: "work-item.create",
    route: "automation-worker",
    resourceId: null,
    parentId: null,
    payload: {
      spaceId: rule.target_space_id,
      title: rule.title,
      accountableOwnerId: rule.created_by,
      description: "",
      type: "Task",
      workflowStateId: stateId,
      projectId: null,
      priority: "none",
      labelIds: [],
      startDate: null,
      dueDate: null,
    },
  })
  const workId = z.object({ id: z.string() }).parse(created.result).id
  await transaction`insert into recurrence_occurrences
    (rule_id,scheduled_for,template_revision,outcome,work_item_id,created_at)
    values (${rule.id},${scheduledFor},${rule.template_revision},'created',${workId},clock_timestamp())`
  await transaction`update recurrence_rules set next_run_at=${next} where id=${rule.id}`
}

export class RecurrenceWorkerError extends Error {
  override readonly name = "RecurrenceWorkerError"
}

function isRuleFailure(error: unknown): boolean {
  return (
    error instanceof z.ZodError ||
    error instanceof RangeError ||
    error instanceof RecurrenceWorkerError ||
    error instanceof EntityNotFoundError ||
    error instanceof EntityRevisionConflictError ||
    error instanceof CommandIdempotencyConflictError ||
    error instanceof CommandInvariantError
  )
}
