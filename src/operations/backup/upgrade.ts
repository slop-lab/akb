import type { TransactionSql } from "postgres"
import { readMigrationCatalog } from "../../postgres/migrate.ts"
import { backupError } from "./errors.ts"
import { readTrustedLocalProfiles } from "./profile-catalog.ts"
import { type BackupProfile, PROFILE_010 } from "./profiles.ts"

export async function upgradeSchemaTo010(
  transaction: TransactionSql,
  sourceProfile: BackupProfile,
): Promise<void> {
  await readTrustedLocalProfiles()
  const migrations = await readMigrationCatalog()
  const forward = migrations.slice(sourceProfile.migrations.length)
  if (forward.length !== PROFILE_010.migrations.length - sourceProfile.migrations.length) {
    throw backupError("upgrade_catalog_mismatch", "registered upgrade to 010 is incomplete")
  }
  await transaction`set local search_path = public`
  for (const migration of forward) {
    await transaction.unsafe(migration.contents.toString("utf8")).simple()
    await transaction`insert into schema_migrations (version, checksum)
      values (${migration.version}, ${migration.checksum})`
  }
}
