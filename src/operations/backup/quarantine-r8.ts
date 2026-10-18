import type { TransactionSql } from "postgres"
import { z } from "zod"
import { backupError } from "./errors.ts"
import { quarantineAuthority, type RecoveryCountsV2 } from "./quarantine.ts"
import { type QuarantineAssertionsV3, quarantineAssertions } from "./recovery.ts"

export type CurrentQuarantineResult = {
  readonly counts: RecoveryCountsV2
  readonly assertions: QuarantineAssertionsV3
}

export async function quarantineCurrentAuthority(
  transaction: TransactionSql,
  recoveryAt: string,
): Promise<CurrentQuarantineResult> {
  const overflow = await transaction`select exists (
    select 1 from runtime_runs where state in
      ('queued','preparing','running','awaiting_input','verifying','review_required','cancel_requested')
      and generation = 9223372036854775807
    union all
    select 1 from outgoing_https_requests
      where state='delivering' and lease_generation = 9223372036854775807
  ) as value`
  if (z.strictObject({ value: z.boolean() }).parse(overflow[0]).value) {
    throw backupError("lease_generation_overflow", "restored run generation cannot be fenced")
  }
  const base = await quarantineAuthority(transaction, recoveryAt, true)
  const counts = await quarantineRows(transaction, recoveryAt)
  const remaining = await remainingAuthority(transaction, recoveryAt)
  return {
    counts: {
      ...base.counts,
      revokedRunCredentials: counts.revoked_run_credentials,
      expiredRuntimeLeases: counts.expired_runtime_leases,
      disabledRuntimeCapabilities: counts.disabled_caps,
      clearedRuntimeContextSnapshots: counts.cleared_contexts,
      clearedContentPresence: counts.cleared_presence,
      rotatedIntegrationCredentials: counts.rotated_integrations,
      disabledRecurrences: counts.disabled_recurrences,
      disabledAutomations: counts.disabled_automations,
      quarantinedDeliveryJobs: counts.quarantined_jobs,
    },
    assertions: quarantineAssertions({
      ...base.assertions,
      activeRunCredentials: remaining.active_run_credentials,
      activeRuntimeLeases: remaining.active_leases,
      enabledRuntimeCapabilities: remaining.enabled_caps,
      runtimeContextSnapshots: remaining.context_snapshots,
      enabledIntegrations: remaining.enabled_integrations,
      dispatchableDeliveryJobs: remaining.dispatchable_jobs,
    }),
  }
}

async function quarantineRows(transaction: TransactionSql, recoveryAt: string) {
  const rows = await transaction`with
    runs as (
      update runtime_runs set token_hash=public.digest(gen_random_uuid()::text,'sha256'),
        token_expires_at=${recoveryAt},
        generation=case when state in
          ('queued','preparing','running','awaiting_input','verifying','review_required','cancel_requested')
          then generation+1 else generation end,
        state=case when state in
          ('queued','preparing','running','awaiting_input','verifying','review_required','cancel_requested')
          then 'stale' else state end,
        updated_at=${recoveryAt} returning 1
    ), leases as (
      update runtime_leases set status='expired',expires_at=${recoveryAt},
        heartbeat_deadline=${recoveryAt} where status in ('issued','acknowledged') returning 1
    ), installations as (update agent_installations set enabled=false where enabled returning 1),
    extension_installations_disabled as (
      update extension_installations set enabled=false where enabled returning 1
    ),
    endpoints as (update runtime_endpoints set enabled=false where enabled returning 1),
    contexts as (delete from runtime_context_snapshots returning 1),
    presence as (delete from content_presence returning 1),
    integrations as (update github_installations set webhook_secret=public.gen_random_bytes(32) returning 1),
    recurrences as (update recurrence_rules set enabled=false where enabled returning 1),
    automations as (update automation_rules set enabled=false where enabled returning 1),
    automation_runs_quarantined as (
      update automation_runs set state='dead_letter',completed_at=coalesce(completed_at,${recoveryAt})
      where state in ('pending','running','failed') returning 1
    ), automation_actions as (
      update automation_action_jobs set state='dead_letter'
      where state in ('pending','failed') returning 1
    ), github_deliveries as (
      update github_webhook_deliveries set state='dead_letter'
      where state in ('pending','processing','failed') returning 1
    ), outgoing as (
      update outgoing_https_requests set state='dead_letter',lease_owner=null,lease_expires_at=null,
        lease_generation=case when state='delivering' then lease_generation+1 else lease_generation end
      where state in ('pending','failed','delivering') returning 1
    ) select
      (select count(*)::integer from runs) revoked_run_credentials,
      (select count(*)::integer from leases) expired_runtime_leases,
      ((select count(*) from installations)+(select count(*) from endpoints)+
        (select count(*) from extension_installations_disabled))::integer disabled_caps,
      (select count(*)::integer from contexts) cleared_contexts,
      (select count(*)::integer from presence) cleared_presence,
      (select count(*)::integer from integrations) rotated_integrations,
      (select count(*)::integer from recurrences) disabled_recurrences,
      (select count(*)::integer from automations) disabled_automations,
      ((select count(*) from automation_runs_quarantined)+(select count(*) from automation_actions)+
        (select count(*) from github_deliveries)+(select count(*) from outgoing))::integer quarantined_jobs`
  return z
    .strictObject({
      revoked_run_credentials: z.number().int().nonnegative(),
      expired_runtime_leases: z.number().int().nonnegative(),
      disabled_caps: z.number().int().nonnegative(),
      cleared_contexts: z.number().int().nonnegative(),
      cleared_presence: z.number().int().nonnegative(),
      rotated_integrations: z.number().int().nonnegative(),
      disabled_recurrences: z.number().int().nonnegative(),
      disabled_automations: z.number().int().nonnegative(),
      quarantined_jobs: z.number().int().nonnegative(),
    })
    .parse(rows[0])
}

async function remainingAuthority(transaction: TransactionSql, recoveryAt: string) {
  const rows = await transaction`select
    (select count(*)::integer from runtime_runs where token_expires_at>${recoveryAt}) active_run_credentials,
    (select count(*)::integer from runtime_leases where status in ('issued','acknowledged')) active_leases,
    ((select count(*) from agent_installations where enabled)+
      (select count(*) from runtime_endpoints where enabled)+
      (select count(*) from extension_installations where enabled))::integer enabled_caps,
    (select count(*)::integer from runtime_context_snapshots) context_snapshots,
    (select count(*)::integer from recurrence_rules where enabled) +
      (select count(*)::integer from automation_rules where enabled) enabled_integrations,
    (select count(*)::integer from automation_runs where state in ('pending','running','failed')) +
      (select count(*)::integer from automation_action_jobs where state in ('pending','failed')) +
      (select count(*)::integer from github_webhook_deliveries
        where state in ('pending','processing','failed')) +
      (select count(*)::integer from outgoing_https_requests
        where state in ('pending','failed','delivering')) dispatchable_jobs`
  return z
    .strictObject({
      active_run_credentials: z.number().int().nonnegative(),
      active_leases: z.number().int().nonnegative(),
      enabled_caps: z.number().int().nonnegative(),
      context_snapshots: z.number().int().nonnegative(),
      enabled_integrations: z.number().int().nonnegative(),
      dispatchable_jobs: z.number().int().nonnegative(),
    })
    .parse(rows[0])
}
