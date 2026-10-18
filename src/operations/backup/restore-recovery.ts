import type { TransactionSql } from "postgres"
import { digestTables, validateApplicationDatabase } from "./database.ts"
import { backupError } from "./errors.ts"
import type { BackupManifest, TableDigest } from "./manifest.ts"
import { type BackupProfile, PROFILE_004, PROFILE_016, profileFromId } from "./profiles.ts"
import { type QuarantineResult, quarantineAuthority, type RecoveryCountsV2 } from "./quarantine.ts"
import { quarantineCurrentAuthority } from "./quarantine-r8.ts"
import type { QuarantineAssertionsV3 } from "./recovery.ts"
import { upgradeSchemaToCurrent } from "./upgrade.ts"

export type RecoveryState = {
  readonly sourceProfile: BackupProfile
  readonly finalProfile: BackupProfile
  readonly sourceBaseline: readonly TableDigest[]
  readonly finalBaseline: readonly TableDigest[]
  readonly postRecovery: readonly TableDigest[]
  readonly counts: RecoveryCountsV2
  readonly assertions: QuarantineAssertionsV3
}

export async function recoverRestoredDatabase(
  transaction: TransactionSql,
  manifest: BackupManifest,
  recoveryAt: string,
): Promise<RecoveryState> {
  const sourceProfile = manifest.formatVersion === 1 ? PROFILE_004 : profileFromId(manifest.profile)
  await lockTables(
    transaction,
    sourceProfile.tables.map(({ name }) => name),
  )
  await validateApplicationDatabase(transaction, sourceProfile.migrations)
  const sourceBaseline = await digestTables(transaction, "full", sourceProfile)
  if (JSON.stringify(sourceBaseline) !== JSON.stringify(manifest.tables)) {
    throw backupError(
      "restored_digest_mismatch",
      "restored baseline does not match backup manifest",
    )
  }

  if (sourceProfile.id === PROFILE_016.id) {
    const protectedBefore = await digestTables(transaction, "protected", PROFILE_016)
    const quarantine = await quarantineCurrentAuthority(transaction, recoveryAt)
    const postRecovery = await digestTables(transaction, "full", PROFILE_016)
    const protectedAfter = await digestTables(transaction, "protected", PROFILE_016)
    assertProtectedTransformation(
      sourceBaseline,
      postRecovery,
      protectedBefore,
      protectedAfter,
      true,
    )
    return {
      sourceProfile,
      finalProfile: PROFILE_016,
      sourceBaseline,
      finalBaseline: sourceBaseline,
      postRecovery,
      counts: quarantine.counts,
      assertions: quarantine.assertions,
    }
  }

  const includeR4 = sourceProfile.id !== PROFILE_004.id
  const legacyProtected = await digestTables(transaction, "protected", sourceProfile)
  const legacyQuarantine = await quarantineAuthority(transaction, recoveryAt, includeR4)
  const legacyPost = await digestTables(transaction, "full", sourceProfile)
  const legacyProtectedPost = await digestTables(transaction, "protected", sourceProfile)
  assertProtectedTransformation(
    sourceBaseline,
    legacyPost,
    legacyProtected,
    legacyProtectedPost,
    includeR4,
  )
  await upgradeSchemaToCurrent(transaction, sourceProfile)
  await validateApplicationDatabase(transaction, PROFILE_016.migrations)
  await lockTables(
    transaction,
    PROFILE_016.tables.slice(sourceProfile.tables.length).map(({ name }) => name),
  )
  const finalBaseline = await digestTables(transaction, "full", PROFILE_016)
  const finalProtected = await digestTables(transaction, "protected", PROFILE_016)
  const currentQuarantine = await quarantineCurrentAuthority(transaction, recoveryAt)
  const postRecovery = await digestTables(transaction, "full", PROFILE_016)
  const finalProtectedPost = await digestTables(transaction, "protected", PROFILE_016)
  assertProtectedTransformation(
    finalBaseline,
    postRecovery,
    finalProtected,
    finalProtectedPost,
    true,
  )
  return {
    sourceProfile,
    finalProfile: PROFILE_016,
    sourceBaseline,
    finalBaseline,
    postRecovery,
    counts: combineCounts(legacyQuarantine, currentQuarantine),
    assertions: currentQuarantine.assertions,
  }
}

async function lockTables(transaction: TransactionSql, tables: readonly string[]): Promise<void> {
  if (tables.length === 0) return
  await transaction.unsafe(
    `lock table ${tables.map((name) => `public.${name}`).join(", ")} in access exclusive mode`,
  )
}

function assertProtectedTransformation(
  baseline: readonly TableDigest[],
  postRecovery: readonly TableDigest[],
  protectedBaseline: readonly TableDigest[],
  protectedPost: readonly TableDigest[],
  includeR4: boolean,
): void {
  const mutable = new Set([
    "principal_credentials",
    "outbox_jobs",
    ...(includeR4
      ? [
          "entity_outbox_jobs_v1",
          "human_query_snapshots",
          "human_query_snapshot_items",
          "import_batches",
          "import_record_ids",
          "runtime_runs",
          "runtime_leases",
          "agent_installations",
          "extension_installations",
          "runtime_endpoints",
          "runtime_context_snapshots",
          "runtime_context_entries",
          "content_presence",
          "github_installations",
          "recurrence_rules",
          "automation_rules",
          "automation_runs",
          "automation_action_jobs",
          "outgoing_https_requests",
          "github_webhook_deliveries",
        ]
      : []),
  ])
  for (let index = 0; index < baseline.length; index += 1) {
    const before = baseline[index]
    const after = postRecovery[index]
    if (before === undefined || after === undefined) {
      throw backupError("quarantine_failed", "table digest missing")
    }
    if (!mutable.has(before.name) && JSON.stringify(before) !== JSON.stringify(after)) {
      throw backupError("quarantine_failed", "recovery changed protected application data")
    }
  }
  if (JSON.stringify(protectedBaseline) !== JSON.stringify(protectedPost)) {
    throw backupError("quarantine_failed", "recovery changed protected columns or retained rows")
  }
}

function combineCounts(legacy: QuarantineResult, r4: QuarantineResult): RecoveryCountsV2 {
  return {
    revokedCredentials: legacy.counts.revokedCredentials + r4.counts.revokedCredentials,
    leasedToPending: legacy.counts.leasedToPending + r4.counts.leasedToPending,
    leasedToDeadLetter: legacy.counts.leasedToDeadLetter + r4.counts.leasedToDeadLetter,
    generationIncrements: legacy.counts.generationIncrements + r4.counts.generationIncrements,
    genericLeasedToPending: r4.counts.genericLeasedToPending,
    genericLeasedToDeadLetter: r4.counts.genericLeasedToDeadLetter,
    genericGenerationIncrements: r4.counts.genericGenerationIncrements,
    clearedQuerySnapshots: r4.counts.clearedQuerySnapshots,
    clearedQuerySnapshotItems: r4.counts.clearedQuerySnapshotItems,
    clearedValidatedImports: r4.counts.clearedValidatedImports,
    clearedValidatedImportRecordIds: r4.counts.clearedValidatedImportRecordIds,
    revokedRunCredentials: r4.counts.revokedRunCredentials,
    expiredRuntimeLeases: r4.counts.expiredRuntimeLeases,
    disabledRuntimeCapabilities: r4.counts.disabledRuntimeCapabilities,
    clearedRuntimeContextSnapshots: r4.counts.clearedRuntimeContextSnapshots,
    clearedContentPresence: r4.counts.clearedContentPresence,
    rotatedIntegrationCredentials: r4.counts.rotatedIntegrationCredentials,
    disabledRecurrences: r4.counts.disabledRecurrences,
    disabledAutomations: r4.counts.disabledAutomations,
    quarantinedDeliveryJobs: r4.counts.quarantinedDeliveryJobs,
  }
}
