import type { TransactionSql } from "postgres"
import { readMigrationCatalog } from "../../postgres/migrate.ts"
import { backupError } from "./errors.ts"
import { readTrustedLocalProfiles } from "./profile-catalog.ts"
import { PROFILE_004, PROFILE_008 } from "./profiles.ts"

export async function upgradeSchema004To008(transaction: TransactionSql): Promise<void> {
  await readTrustedLocalProfiles()
  const migrations = await readMigrationCatalog()
  const forward = migrations.slice(PROFILE_004.migrations.length)
  if (forward.length !== PROFILE_008.migrations.length - PROFILE_004.migrations.length) {
    throw backupError("upgrade_catalog_mismatch", "registered 004 to 008 upgrade is incomplete")
  }
  await transaction`set local search_path = public`
  for (const migration of forward) {
    await transaction.unsafe(migration.contents.toString("utf8")).simple()
    await transaction`insert into schema_migrations (version, checksum)
      values (${migration.version}, ${migration.checksum})`
  }
}
