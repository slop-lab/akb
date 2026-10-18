import type { TransactionSql } from "postgres"
import { z } from "zod"
import { backupError } from "./errors.ts"
import { type QuarantineAssertionsV2, quarantineAssertions } from "./recovery.ts"

const JobCountsSchema = z.strictObject({
  pending: z.number().int().nonnegative(),
  dead: z.number().int().nonnegative(),
})
const CountSchema = z.strictObject({ value: z.number().int().nonnegative() })

export type RecoveryCountsV2 = {
  readonly revokedCredentials: number
  readonly leasedToPending: number
  readonly leasedToDeadLetter: number
  readonly generationIncrements: number
  readonly genericLeasedToPending: number
  readonly genericLeasedToDeadLetter: number
  readonly genericGenerationIncrements: number
  readonly clearedQuerySnapshots: number
  readonly clearedQuerySnapshotItems: number
  readonly clearedValidatedImports: number
  readonly clearedValidatedImportRecordIds: number
  readonly revokedRunCredentials: number
  readonly expiredRuntimeLeases: number
  readonly disabledRuntimeCapabilities: number
  readonly clearedRuntimeContextSnapshots: number
  readonly clearedContentPresence: number
  readonly rotatedIntegrationCredentials: number
  readonly disabledRecurrences: number
  readonly disabledAutomations: number
  readonly quarantinedDeliveryJobs: number
}

export type QuarantineResult = {
  readonly counts: RecoveryCountsV2
  readonly assertions: QuarantineAssertionsV2
}

export async function quarantineAuthority(
  transaction: TransactionSql,
  recoveryAt: string,
  includeR4: boolean,
): Promise<QuarantineResult> {
  const overflow = includeR4
    ? await transaction`select exists (select 1 from outbox_jobs where state = 'leased'
        and lease_generation = 9223372036854775807) or exists (
        select 1 from entity_outbox_jobs_v1 where state = 'leased'
          and lease_generation = 9223372036854775807) as value`
    : await transaction`select exists (select 1 from outbox_jobs where state = 'leased'
        and lease_generation = 9223372036854775807) as value`
  if (z.strictObject({ value: z.boolean() }).parse(overflow[0]).value) {
    throw backupError("lease_generation_overflow", "restored lease generation cannot be fenced")
  }
  const credentials = await transaction`with revoked as (
    update principal_credentials set revoked_at = ${recoveryAt}
    where revoked_at is null returning 1
  ) select count(*)::integer as value from revoked`
  const legacyJobs = await fenceJobs(transaction, "outbox_jobs")
  const genericJobs = includeR4
    ? await fenceJobs(transaction, "entity_outbox_jobs_v1")
    : { pending: 0, dead: 0 }
  const transient = includeR4 ? await clearTransientState(transaction) : emptyTransientCounts()
  const remaining = includeR4
    ? await transaction`select
        (select count(*)::integer from principal_credentials where revoked_at is null) as active_credentials,
        (select count(*)::integer from outbox_jobs where state = 'leased') as leased_jobs,
        (select count(*)::integer from entity_outbox_jobs_v1 where state = 'leased') as generic_leased_jobs`
    : await transaction`select
        (select count(*)::integer from principal_credentials where revoked_at is null) as active_credentials,
        (select count(*)::integer from outbox_jobs where state = 'leased') as leased_jobs,
        0::integer as generic_leased_jobs`
  const parsedRemaining = z
    .strictObject({
      active_credentials: z.number().int().nonnegative(),
      leased_jobs: z.number().int().nonnegative(),
      generic_leased_jobs: z.number().int().nonnegative(),
    })
    .parse(remaining[0])
  return {
    counts: {
      revokedCredentials: CountSchema.parse(credentials[0]).value,
      leasedToPending: legacyJobs.pending,
      leasedToDeadLetter: legacyJobs.dead,
      generationIncrements: legacyJobs.pending + legacyJobs.dead,
      genericLeasedToPending: genericJobs.pending,
      genericLeasedToDeadLetter: genericJobs.dead,
      genericGenerationIncrements: genericJobs.pending + genericJobs.dead,
      ...transient,
      ...emptyR8Counts(),
    },
    assertions: quarantineAssertions({
      activeCredentials: parsedRemaining.active_credentials,
      leasedJobs: parsedRemaining.leased_jobs,
      genericLeasedJobs: parsedRemaining.generic_leased_jobs,
    }),
  }
}

async function fenceJobs(
  transaction: TransactionSql,
  table: "outbox_jobs" | "entity_outbox_jobs_v1",
): Promise<{ readonly pending: number; readonly dead: number }> {
  const rows = await transaction.unsafe(`with fenced as (
    update ${table} set state = case when attempts >= 5 then 'dead_letter' else 'pending' end,
      lease_owner = null, lease_expires_at = null, lease_generation = lease_generation + 1
    where state = 'leased' returning state
  ) select count(*) filter (where state = 'pending')::integer as pending,
    count(*) filter (where state = 'dead_letter')::integer as dead from fenced`)
  return JobCountsSchema.parse(rows[0])
}

async function clearTransientState(transaction: TransactionSql): Promise<{
  readonly clearedQuerySnapshots: number
  readonly clearedQuerySnapshotItems: number
  readonly clearedValidatedImports: number
  readonly clearedValidatedImportRecordIds: number
}> {
  const counts = await transaction`select
    (select count(*)::integer from human_query_snapshots) as snapshots,
    (select count(*)::integer from human_query_snapshot_items) as snapshot_items,
    (select count(*)::integer from import_batches where state = 'validated') as imports,
    (select count(*)::integer from import_record_ids r join import_batches b using (import_id)
      where b.state = 'validated') as import_records`
  const parsed = z
    .strictObject({
      snapshots: z.number().int().nonnegative(),
      snapshot_items: z.number().int().nonnegative(),
      imports: z.number().int().nonnegative(),
      import_records: z.number().int().nonnegative(),
    })
    .parse(counts[0])
  await transaction`delete from human_query_snapshots`
  await transaction`delete from import_batches where state = 'validated'`
  return {
    clearedQuerySnapshots: parsed.snapshots,
    clearedQuerySnapshotItems: parsed.snapshot_items,
    clearedValidatedImports: parsed.imports,
    clearedValidatedImportRecordIds: parsed.import_records,
  }
}

function emptyTransientCounts() {
  return {
    clearedQuerySnapshots: 0,
    clearedQuerySnapshotItems: 0,
    clearedValidatedImports: 0,
    clearedValidatedImportRecordIds: 0,
  } as const
}

function emptyR8Counts() {
  return {
    revokedRunCredentials: 0,
    expiredRuntimeLeases: 0,
    disabledRuntimeCapabilities: 0,
    clearedRuntimeContextSnapshots: 0,
    clearedContentPresence: 0,
    rotatedIntegrationCredentials: 0,
    disabledRecurrences: 0,
    disabledAutomations: 0,
    quarantinedDeliveryJobs: 0,
  } as const
}
