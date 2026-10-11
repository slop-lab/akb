import { readMigrationCatalog } from "../../postgres/migrate.ts"
import { backupError } from "./errors.ts"
import { type BackupProfile, PROFILE_004, PROFILE_008, profileFromLedger } from "./profiles.ts"

export async function readTrustedLocalProfiles(): Promise<readonly BackupProfile[]> {
  const local = (await readMigrationCatalog()).map(({ version, checksum }) => ({
    name: version,
    checksum,
  }))
  if (JSON.stringify(local) !== JSON.stringify(PROFILE_008.migrations)) {
    throw backupError(
      "migration_catalog_mismatch",
      "local migrations do not match trusted profile 008",
    )
  }
  if (JSON.stringify(local.slice(0, 4)) !== JSON.stringify(PROFILE_004.migrations)) {
    throw backupError(
      "migration_catalog_mismatch",
      "local migrations do not match trusted profile 004",
    )
  }
  return [PROFILE_004, PROFILE_008]
}

export async function trustedProfileFromDatabaseLedger(
  ledger: readonly { readonly name: string; readonly checksum: string }[],
): Promise<BackupProfile> {
  await readTrustedLocalProfiles()
  try {
    return profileFromLedger(ledger)
  } catch (error) {
    throw backupError("database_shape_mismatch", "database ledger has no registered profile", error)
  }
}
