import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import type { Sql } from "postgres"

const MigrationNameSchema = z.string().regex(/^\d{3}_[a-z0-9_]+\.sql$/)
const FIRST_MIGRATION = "001_work_item_persistence.sql"
const FIRST_MIGRATION_CHECKSUM = "e4280616dc2ea677ae7842fbdea46e1842153cd1833c35221216b2be88c1bdbf"
const MigrationRowSchema = z.strictObject({
  version: MigrationNameSchema,
  checksum: z.string().length(64).nullable(),
})

export class MigrationIntegrityError extends Error {
  override readonly name = "MigrationIntegrityError"
}

export async function migrateDatabase(
  sql: Sql,
  directory = resolve(process.cwd(), "migrations"),
): Promise<void> {
  const names = (await readdir(directory))
    .filter((name) => MigrationNameSchema.safeParse(name).success)
    .sort()
  const versions = new Set<number>()
  for (const name of names) {
    const version = migrationVersion(name)
    if (versions.has(version)) {
      throw new MigrationIntegrityError(`duplicate migration version ${name.slice(0, 3)}`)
    }
    versions.add(version)
  }
  const migrations = await Promise.all(
    names.map(async (version) => {
      const contents = await readFile(resolve(directory, version))
      return {
        version,
        contents,
        checksum: createHash("sha256").update(contents).digest("hex"),
      }
    }),
  )
  const first = migrations.find((migration) => migration.version === FIRST_MIGRATION)
  if (first?.checksum !== FIRST_MIGRATION_CHECKSUM) {
    throw new MigrationIntegrityError(`checksum mismatch for ${FIRST_MIGRATION}`)
  }

  await sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtextextended(current_schema(), 0))`
    await transaction`
      create table if not exists schema_migrations (
        version text primary key,
        checksum text,
        applied_at timestamptz not null default now()
      )
    `
    await transaction`alter table schema_migrations add column if not exists checksum text`
    const appliedRows = await transaction`select version, checksum from schema_migrations`
    const applied = new Map(
      appliedRows.map((row) => {
        const parsed = MigrationRowSchema.parse(row)
        return [parsed.version, parsed.checksum] as const
      }),
    )
    for (const [version, checksum] of applied) {
      const migration = migrations.find((candidate) => candidate.version === version)
      if (migration === undefined) {
        throw new MigrationIntegrityError(`unknown applied migration: ${version}`)
      }
      if (checksum === null) {
        if (version !== FIRST_MIGRATION || migration.checksum !== FIRST_MIGRATION_CHECKSUM) {
          throw new MigrationIntegrityError(`missing checksum for ${version}`)
        }
        await transaction`update schema_migrations set checksum = ${migration.checksum}
          where version = ${version}`
        applied.set(version, migration.checksum)
      } else if (checksum !== migration.checksum) {
        throw new MigrationIntegrityError(`checksum mismatch for ${version}`)
      }
    }
    const highestApplied = Math.max(-1, ...[...applied.keys()].map(migrationVersion))
    const invalidPending = migrations.find(
      (migration) =>
        !applied.has(migration.version) && migrationVersion(migration.version) <= highestApplied,
    )
    if (invalidPending !== undefined) {
      throw new MigrationIntegrityError(
        `migration history is not append-only: ${invalidPending.version}`,
      )
    }
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue
      await transaction.unsafe(migration.contents.toString("utf8")).simple()
      await transaction`insert into schema_migrations (version, checksum)
        values (${migration.version}, ${migration.checksum})`
    }
    await transaction`alter table schema_migrations alter column checksum set not null`
  })
}

function migrationVersion(name: string): number {
  return z.coerce.number().int().nonnegative().parse(name.slice(0, 3))
}
