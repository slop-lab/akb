import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import type { Sql } from "postgres"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
})

afterEach(async () => {
  await fixture.close()
})

test("concurrent first migrations serialize before creating migration metadata", async () => {
  const clients = Array.from({ length: 16 }, () => fixture.connect())
  try {
    await Promise.all(clients.map((client) => migrateDatabase(client)))
  } finally {
    await Promise.all(clients.map((client) => client.end()))
  }

  const rows = await fixture.sql<{ readonly version: string; readonly checksum: string }[]>`
    select version, checksum from schema_migrations order by version
  `
  assert.deepEqual(
    rows.map((row) => [row.version, row.checksum.length]),
    [
      ["001_work_item_persistence.sql", 64],
      ["002_workspace_identity.sql", 64],
      ["003_transactional_outbox.sql", 64],
    ],
  )
})

test("a separate client can repeat completed migrations", async () => {
  await migrateDatabase(fixture.sql)
  const client: Sql = fixture.connect()
  try {
    await migrateDatabase(client)
  } finally {
    await client.end()
  }

  const rows = await fixture.sql<{ readonly version: string }[]>`
    select version from schema_migrations order by version
  `
  assert.deepEqual(
    rows.map((row) => row.version),
    ["001_work_item_persistence.sql", "002_workspace_identity.sql", "003_transactional_outbox.sql"],
  )
})

test("legacy 001 metadata receives only the pinned checksum before 002 applies", async () => {
  await fixture.sql`create table schema_migrations (
    version text primary key, applied_at timestamptz not null default now()
  )`
  await fixture.sql`insert into schema_migrations (version) values ('001_work_item_persistence.sql')`
  const contents = await readFile(
    join(process.cwd(), "migrations/001_work_item_persistence.sql"),
    "utf8",
  )
  await fixture.sql.unsafe(contents).simple()

  await migrateDatabase(fixture.sql)

  const rows = await fixture.sql<{ readonly version: string; readonly checksum: string }[]>`
    select version, checksum from schema_migrations order by version
  `
  assert.equal(
    rows[0]?.checksum,
    "e4280616dc2ea677ae7842fbdea46e1842153cd1833c35221216b2be88c1bdbf",
  )
  assert.equal(rows[1]?.version, "002_workspace_identity.sql")
})

test("migration drift is rejected before pending SQL executes", async () => {
  await migrateDatabase(fixture.sql)
  const directory = await mkdtemp(join(tmpdir(), "afw-migrations-"))
  try {
    const first = await readFile(
      join(process.cwd(), "migrations/001_work_item_persistence.sql"),
      "utf8",
    )
    const second = await readFile(
      join(process.cwd(), "migrations/002_workspace_identity.sql"),
      "utf8",
    )
    await writeFile(join(directory, "001_work_item_persistence.sql"), `${first}\n-- drift\n`)
    await writeFile(join(directory, "002_workspace_identity.sql"), second)

    await assert.rejects(migrateDatabase(fixture.sql, directory), /checksum/)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test("unknown and null later migration metadata fail closed", async () => {
  await migrateDatabase(fixture.sql)
  await fixture.sql`alter table schema_migrations alter column checksum drop not null`
  await fixture.sql`insert into schema_migrations (version, checksum)
    values ('999_unknown.sql', repeat('0', 64))`
  await assert.rejects(migrateDatabase(fixture.sql), /unknown applied migration/)
  await fixture.sql`delete from schema_migrations where version = '999_unknown.sql'`
  await fixture.sql`update schema_migrations set checksum = null
    where version = '002_workspace_identity.sql'`
  await assert.rejects(migrateDatabase(fixture.sql), /missing checksum/)
})

test("checksum drift in applied migration 002 fails closed", async () => {
  await migrateDatabase(fixture.sql)
  const directory = await mkdtemp(join(tmpdir(), "afw-migrations-"))
  try {
    const first = await readFile(join(process.cwd(), "migrations/001_work_item_persistence.sql"))
    const second = await readFile(
      join(process.cwd(), "migrations/002_workspace_identity.sql"),
      "utf8",
    )
    await writeFile(join(directory, "001_work_item_persistence.sql"), first)
    await writeFile(join(directory, "002_workspace_identity.sql"), `${second}\n-- drift\n`)

    await assert.rejects(migrateDatabase(fixture.sql, directory), /checksum mismatch.*002/)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test("duplicate numeric migration prefixes are rejected before SQL executes", async () => {
  const directory = await copyMigrations()
  try {
    await writeFile(
      join(directory, "002_duplicate.sql"),
      "create table duplicate_ran (id integer);\n",
    )

    await assert.rejects(migrateDatabase(fixture.sql, directory), /duplicate migration version 002/)
    const rows = await fixture.sql<{ readonly exists: boolean }[]>`
      select to_regclass('duplicate_ran') is not null as exists`
    assert.equal(rows[0]?.exists, false)
  } finally {
    await rm(directory, { recursive: true })
  }
})

test("an unapplied migration cannot be inserted below applied history", async () => {
  await migrateDatabase(fixture.sql)
  const directory = await copyMigrations()
  try {
    await writeFile(join(directory, "000_late.sql"), "create table late_ran (id integer);\n")

    await assert.rejects(migrateDatabase(fixture.sql, directory), /not append-only/)
    const rows = await fixture.sql<{ readonly exists: boolean }[]>`
      select to_regclass('late_ran') is not null as exists`
    assert.equal(rows[0]?.exists, false)
  } finally {
    await rm(directory, { recursive: true })
  }
})

async function copyMigrations(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "afw-migrations-"))
  for (const name of [
    "001_work_item_persistence.sql",
    "002_workspace_identity.sql",
    "003_transactional_outbox.sql",
  ] as const) {
    await writeFile(join(directory, name), await readFile(join(process.cwd(), "migrations", name)))
  }
  return directory
}
