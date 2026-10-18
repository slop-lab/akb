import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import { AutomationActionSchema, AutomationConditionSchema } from "../contracts/automation/index.ts"
import { executeAutomationAction } from "./automation-actions.ts"
import { resolveAutomationPrincipal } from "./principal.ts"

const EventRowSchema = z.strictObject({
  id: z.string(),
  workspace_id: z.string(),
  sequence: z.coerce.number().int().positive(),
  event_type: z.string(),
  data: z.looseObject({ automationDepth: z.number().optional() }),
})
const RuleRowSchema = z.strictObject({
  id: z.string(),
  trigger_spec: z.object({ eventType: z.string() }),
  conditions: z.array(AutomationConditionSchema),
  max_runs_per_minute: z.number().int().positive(),
})
const RunRowSchema = z.strictObject({
  id: z.string(),
  rule_id: z.string(),
  workspace_id: z.string(),
  actions: z.array(AutomationActionSchema),
  attempts: z.number().int().nonnegative(),
  owner_id: z.string(),
})

export async function processAutomationEvents(sql: Sql, now: Date, limit: number): Promise<number> {
  return sql.begin(async (transaction) => {
    await transaction`insert into automation_event_checkpoints(workspace_id)
      select distinct workspace_id from entity_events_v1 on conflict do nothing`
    const checkpoints = await transaction<
      { readonly workspace_id: string; readonly last_sequence: number }[]
    >`select checkpoint.workspace_id,checkpoint.last_sequence::integer from automation_event_checkpoints checkpoint
      where exists(select 1 from entity_events_v1 event where event.workspace_id=checkpoint.workspace_id
        and event.sequence>checkpoint.last_sequence)
      order by checkpoint.updated_at,checkpoint.workspace_id for update skip locked limit 1`
    const checkpoint = checkpoints[0]
    if (checkpoint === undefined) return 0
    const events = await transaction`select id,workspace_id,sequence,event_type,data
      from entity_events_v1 where workspace_id=${checkpoint.workspace_id}
        and sequence>${checkpoint.last_sequence} order by sequence limit ${limit}`
    let queued = 0
    for (const rawEvent of events) {
      const event = EventRowSchema.parse(rawEvent)
      const depth = event.data.automationDepth ?? 0
      if (depth >= 8) continue
      const rules = await transaction`select id,trigger_spec,conditions,max_runs_per_minute
        from automation_rules where workspace_id=${event.workspace_id} and enabled
          and trigger_spec->>'eventType'=${event.event_type}`
      for (const rawRule of rules) {
        const rule = RuleRowSchema.parse(rawRule)
        if (!matches(rule.conditions, event.data)) continue
        const recent = await transaction<
          { readonly count: number }[]
        >`select count(*)::integer count
          from automation_runs where rule_id=${rule.id} and created_at>=${new Date(now.getTime() - 60_000).toISOString()}`
        if ((recent[0]?.count ?? 0) >= rule.max_runs_per_minute) continue
        const inserted = await transaction`insert into automation_runs
          (rule_id,event_id,depth,state,available_at,created_at) values (${rule.id},${event.id},
            ${depth + 1},'pending',${now.toISOString()},${now.toISOString()}) on conflict do nothing returning id`
        queued += inserted.length
      }
    }
    const last = EventRowSchema.safeParse(events.at(-1))
    if (last.success)
      await transaction`update automation_event_checkpoints set last_sequence=${last.data.sequence},
        updated_at=clock_timestamp() where workspace_id=${checkpoint.workspace_id}`
    return queued
  })
}

export async function executeAutomationRuns(sql: Sql, now: Date, limit: number): Promise<number> {
  return sql.begin(async (transaction) => {
    const rows =
      await transaction`select run.id::text,run.rule_id,rule.workspace_id,rule.actions,run.attempts,
        rule.owner_id
      from automation_runs run join automation_rules rule on rule.id=run.rule_id
      where run.state in ('pending','failed') and run.available_at<=${now.toISOString()}
      order by run.available_at,run.id for update of run skip locked limit ${limit}`
    const runs = rows.map((row) => RunRowSchema.parse(row))
    for (const run of runs) await executeRun(transaction, run, now)
    return runs.length
  })
}

function matches(
  conditions: readonly z.infer<typeof AutomationConditionSchema>[],
  data: Readonly<Record<string, unknown>>,
): boolean {
  return conditions.every((condition) => Object.is(data[condition.field], condition.equals))
}

async function executeRun(
  transaction: TransactionSql,
  run: z.infer<typeof RunRowSchema>,
  now: Date,
): Promise<void> {
  await transaction`update automation_runs set state='running',attempts=attempts+1 where id=${run.id}::uuid`
  try {
    const principal = await resolveAutomationPrincipal(transaction, run.workspace_id, run.owner_id)
    for (const [ordinal, action] of run.actions.entries()) {
      await transaction`insert into automation_action_jobs
        (run_id,ordinal,action,state,available_at) values (${run.id}::uuid,${ordinal},
          ${JSON.stringify(action)}::text::jsonb,'pending',${now.toISOString()}) on conflict do nothing`
      const jobs = await transaction<
        { readonly state: string }[]
      >`select state from automation_action_jobs where run_id=${run.id}::uuid and ordinal=${ordinal}`
      if (jobs[0]?.state === "succeeded") continue
      await executeAutomationAction(
        transaction,
        {
          id: run.id,
          ruleId: run.rule_id,
          workspaceId: run.workspace_id,
          principal,
        },
        action,
        ordinal,
        now,
      )
      await transaction`update automation_action_jobs set state='succeeded',completed_at=clock_timestamp()
        where run_id=${run.id}::uuid and ordinal=${ordinal}`
    }
    await transaction`update automation_runs set state='succeeded',completed_at=clock_timestamp() where id=${run.id}::uuid`
    await transaction`update automation_rules set last_run_at=clock_timestamp() where id=${run.rule_id}`
  } catch (error) {
    const attempts = run.attempts + 1
    const message = error instanceof Error ? error.message : "automation action failed"
    const state = attempts >= 5 ? "dead_letter" : "failed"
    await transaction`update automation_runs set state=${state},attempts=${attempts},last_error=${message},
      available_at=${new Date(now.getTime() + 2 ** attempts * 1_000).toISOString()} where id=${run.id}::uuid`
  }
}

export class AutomationWorkerError extends Error {
  override readonly name = "AutomationWorkerError"
}
