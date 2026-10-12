import type { TransactionSql } from "postgres"
import { digestTables, validateApplicationDatabase } from "./database.ts"
import { backupError } from "./errors.ts"
import type { BackupManifest, TableDigest } from "./manifest.ts"
import { type BackupProfile, PROFILE_004, PROFILE_010, profileFromId } from "./profiles.ts"
import { type QuarantineResult, quarantineAuthority, type RecoveryCountsV2 } from "./quarantine.ts"
import type { QuarantineAssertionsV2 } from "./recovery.ts"
import { upgradeSchemaTo010 } from "./upgrade.ts"

export type RecoveryState = {
  readonly sourceProfile: BackupProfile
  readonly finalProfile: BackupProfile
  readonly sourceBaseline: readonly TableDigest[]
  readonly finalBaseline: readonly TableDigest[]
  readonly postRecovery: readonly TableDigest[]
  readonly counts: RecoveryCountsV2
  readonly assertions: QuarantineAssertionsV2
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

  if (sourceProfile.id === PROFILE_010.id) {
    const protectedBefore = await digestTables(transaction, "protected", PROFILE_010)
    const quarantine = await quarantineAuthority(transaction, recoveryAt, true)
    const postRecovery = await digestTables(transaction, "full", PROFILE_010)
    const protectedAfter = await digestTables(transaction, "protected", PROFILE_010)
    assertProtectedTransformation(
      sourceBaseline,
      postRecovery,
      protectedBefore,
      protectedAfter,
      true,
    )
    return {
      sourceProfile,
      finalProfile: PROFILE_010,
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
  await upgradeSchemaTo010(transaction, sourceProfile)
  await validateApplicationDatabase(transaction, PROFILE_010.migrations)
  await lockTables(
    transaction,
    PROFILE_010.tables.slice(sourceProfile.tables.length).map(({ name }) => name),
  )
  const finalBaseline = await digestTables(transaction, "full", PROFILE_010)
  const finalProtected = await digestTables(transaction, "protected", PROFILE_010)
  const r4Quarantine = await quarantineAuthority(transaction, recoveryAt, true)
  const postRecovery = await digestTables(transaction, "full", PROFILE_010)
  const finalProtectedPost = await digestTables(transaction, "protected", PROFILE_010)
  assertProtectedTransformation(
    finalBaseline,
    postRecovery,
    finalProtected,
    finalProtectedPost,
    true,
  )
  return {
    sourceProfile,
    finalProfile: PROFILE_010,
    sourceBaseline,
    finalBaseline,
    postRecovery,
    counts: combineCounts(legacyQuarantine, r4Quarantine),
    assertions: r4Quarantine.assertions,
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
  }
}
