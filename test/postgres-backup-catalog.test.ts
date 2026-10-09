import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import postgres, { type Sql } from "postgres"
import { schemaFingerprint } from "../src/operations/backup/catalog.ts"
import { createBackup } from "../src/operations/backup/create.ts"
import { validateApplicationDatabase } from "../src/operations/backup/database.ts"
import type { MigrationDigest } from "../src/operations/backup/manifest.ts"
import { EXPECTED_SCHEMA_FINGERPRINT } from "../src/operations/backup/schema-policy.ts"
import { migrateDatabase, readMigrationCatalog } from "../src/postgres/migrate.ts"
import { createOwnedDatabase, databaseUrl, requiredEnvironment } from "./postgres-backup-fixture.ts"

const adminUrl = requiredEnvironment("DATABASE_URL")
const pgDumpPath = requiredEnvironment("PG_DUMP_PATH")
const migrations: readonly MigrationDigest[] = (await readMigrationCatalog()).map(
  ({ version, checksum }) => ({ name: version, checksum }),
)

type CatalogDatabase = {
  readonly name: string
  readonly url: string
  readonly sql: Sql
  readonly close: () => Promise<void>
}

async function createCatalogDatabase(): Promise<CatalogDatabase> {
  const name = `backup_catalog_${randomUUID().replaceAll("-", "")}`
  const admin = postgres(adminUrl, { max: 1 })
  await admin`create database ${admin(name)} template template0`
  const url = databaseUrl(adminUrl, name)
  const sql = postgres(url, { max: 1 })
  await migrateDatabase(sql)
  return {
    name,
    url,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 })
      await admin`drop database ${admin(name)} with (force)`
      await admin.end({ timeout: 5 })
    },
  }
}

async function createOwnedCatalogDatabase(): Promise<CatalogDatabase & { readonly role: string }> {
  const admin = postgres(adminUrl, { max: 1 })
  const database = await createOwnedDatabase(admin, adminUrl, "backup_catalog")
  const sql = postgres(database.url, { max: 1 })
  await migrateDatabase(sql)
  return {
    ...database,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 })
      await admin`drop database ${admin(database.name)} with (force)`
      await admin`drop role ${admin(database.role)}`
      await admin.end({ timeout: 5 })
    },
  }
}

test("two fresh schema-004 databases match the pin despite a shadow user schema", async (context) => {
  // Given
  const first = await createCatalogDatabase()
  const second = await createCatalogDatabase()
  context.after(first.close)
  context.after(second.close)
  const roleRows = await first.sql<{ readonly role: string }[]>`select current_user as role`
  const role = roleRows[0]?.role
  if (role === undefined) throw new TypeError("database role is unavailable")
  await first.sql`create schema ${first.sql(role)}`
  await first.sql`create table ${first.sql(role)}.work_items (id text primary key)`
  await first.sql`create function ${first.sql(role)}.reject_work_item_scope_mutation()
    returns trigger language plpgsql as $$ begin return new; end $$`
  await first.sql`alter role ${first.sql(role)} in database ${first.sql(first.name)}
    set search_path = ${first.sql(role)}, public`
  const shadowed = postgres(first.url, { max: 1 })
  context.after(() => shadowed.end({ timeout: 5 }))

  // When
  const firstFingerprint = await shadowed.begin(async (transaction) => {
    await validateApplicationDatabase(transaction, migrations)
    return schemaFingerprint(transaction)
  })
  const secondFingerprint = await second.sql.begin((transaction) => schemaFingerprint(transaction))

  // Then
  assert.equal(firstFingerprint, EXPECTED_SCHEMA_FINGERPRINT)
  assert.equal(secondFingerprint, EXPECTED_SCHEMA_FINGERPRINT)
})

test("fresh databases owned by bootstrap and ordinary login roles match the schema pin", async (context) => {
  // Given
  const bootstrapOwned = await createCatalogDatabase()
  const loginOwned = await createOwnedCatalogDatabase()
  context.after(bootstrapOwned.close)
  context.after(loginOwned.close)
  const roleRows = await loginOwned.sql<
    {
      readonly current_user: string
      readonly superuser: boolean
      readonly createDatabase: boolean
    }[]
  >`select current_user, r.rolsuper as superuser, r.rolcreatedb as "createDatabase"
    from pg_roles r where r.rolname = current_user`

  // When
  const bootstrapFingerprint = await bootstrapOwned.sql.begin((transaction) =>
    schemaFingerprint(transaction),
  )
  const loginFingerprint = await loginOwned.sql.begin((transaction) =>
    schemaFingerprint(transaction),
  )

  // Then
  assert.deepEqual(roleRows[0], {
    current_user: loginOwned.role,
    superuser: false,
    createDatabase: false,
  })
  assert.equal(bootstrapFingerprint, loginFingerprint)
  assert.equal(bootstrapFingerprint, EXPECTED_SCHEMA_FINGERPRINT)
  assert.equal(loginFingerprint, EXPECTED_SCHEMA_FINGERPRINT)
})

test("changing a public table away from the database owner fails schema validation", async (context) => {
  // Given
  const database = await createOwnedCatalogDatabase()
  context.after(database.close)
  const admin = postgres(databaseUrl(adminUrl, database.name), { max: 1 })
  context.after(() => admin.end({ timeout: 5 }))
  await admin`alter table public.work_items owner to current_user`

  // When / Then
  await assert.rejects(
    database.sql.begin((transaction) => validateApplicationDatabase(transaction, migrations)),
    /fingerprint/,
  )
})

test("standalone enum, domain, and composite types fail schema validation", async (context) => {
  // Given
  const mutations = [
    "create type extra_enum as enum ('one', 'two')",
    "create domain extra_domain as text check (value <> '')",
    "create type extra_composite as (label text, revision bigint)",
  ] as const
  const databases = await Promise.all(mutations.map(() => createCatalogDatabase()))
  for (const database of databases) context.after(database.close)

  // When / Then
  for (let index = 0; index < mutations.length; index += 1) {
    const database = databases[index]
    const mutation = mutations[index]
    if (database === undefined || mutation === undefined) throw new TypeError("fixture is missing")
    await database.sql.unsafe(mutation)
    await assert.rejects(
      database.sql.begin((transaction) => validateApplicationDatabase(transaction, migrations)),
      /fingerprint/,
    )
  }
})

test("row-level security flags and policies fail schema validation", async (context) => {
  // Given
  const database = await createCatalogDatabase()
  context.after(database.close)
  await database.sql`alter table public.work_items enable row level security`
  await database.sql`create policy unexpected_policy on public.work_items using (true)`

  // When / Then
  await assert.rejects(
    database.sql.begin((transaction) => validateApplicationDatabase(transaction, migrations)),
    /fingerprint/,
  )
})

test("backup creation rejects an unknown public type before writing a manifest", async (context) => {
  // Given
  const database = await createCatalogDatabase()
  const root = await mkdtemp(join(tmpdir(), "afw-backup-catalog-"))
  const artifact = join(root, "artifact")
  context.after(database.close)
  context.after(() => rm(root, { recursive: true }))
  await database.sql`create type public.unexpected_type as enum ('unexpected')`

  // When
  const creation = createBackup(artifact, database.url, pgDumpPath)

  // Then
  await assert.rejects(creation, /fingerprint/)
  await assert.rejects(access(join(artifact, "manifest.json")))
})
