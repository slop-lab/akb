import type { TransactionSql } from "postgres"
import { readMigrationCatalog } from "../../postgres/migrate.ts"
import { backupError } from "./errors.ts"
import { readTrustedLocalProfiles } from "./profile-catalog.ts"
import { type BackupProfile, PROFILE_016 } from "./profiles.ts"

type MigrationEntry = { readonly name: string; readonly checksum: string }

export function planForwardUpgrade(
  sourceProfile: BackupProfile,
  targetProfile: BackupProfile,
  localCatalog: readonly MigrationEntry[],
): readonly MigrationEntry[] {
  const sourceLength = sourceProfile.migrations.length
  if (
    JSON.stringify(localCatalog) !== JSON.stringify(targetProfile.migrations) ||
    JSON.stringify(localCatalog.slice(0, sourceLength)) !== JSON.stringify(sourceProfile.migrations)
  ) {
    throw backupError(
      "upgrade_catalog_mismatch",
      "upgrade catalog does not match a trusted profile",
    )
  }
  return Object.freeze(localCatalog.slice(sourceLength))
}

export async function upgradeSchemaToCurrent(
  transaction: TransactionSql,
  sourceProfile: BackupProfile,
): Promise<void> {
  await readTrustedLocalProfiles()
  const migrations = await readMigrationCatalog()
  const local = migrations.map(({ version, checksum }) => ({ name: version, checksum }))
  planForwardUpgrade(sourceProfile, PROFILE_016, local)
  const forward = migrations.slice(sourceProfile.migrations.length)
  await transaction`set local search_path = public`
  for (const migration of forward) {
    await transaction.unsafe(migration.contents.toString("utf8")).simple()
    await transaction`insert into schema_migrations (version, checksum)
      values (${migration.version}, ${migration.checksum})`
  }
}
