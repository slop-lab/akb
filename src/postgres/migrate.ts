import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import type { Sql } from "postgres"

const MigrationNameSchema = z.string().regex(/^\d{3}_[a-z0-9_]+\.sql$/)

export async function migrateDatabase(
  sql: Sql,
  directory = resolve(process.cwd(), "migrations"),
): Promise<void> {
  const migrations = (await readdir(directory))
    .filter((name) => MigrationNameSchema.safeParse(name).success)
    .sort()

  await sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtextextended(current_schema(), 0))`
    await transaction`
      create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )
    `
    const appliedRows = await transaction<{ readonly version: string }[]>`
      select version from schema_migrations
    `
    const applied = new Set(appliedRows.map((row) => z.string().parse(row.version)))
    for (const migration of migrations) {
      if (applied.has(migration)) continue
      const contents = await readFile(resolve(directory, migration), "utf8")
      await transaction.unsafe(contents).simple()
      await transaction`insert into schema_migrations (version) values (${migration})`
    }
  })
}
