import assert from "node:assert/strict"
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

  const rows = await fixture.sql<{ readonly version: string }[]>`
    select version from schema_migrations order by version
  `
  assert.deepEqual([...rows], [{ version: "001_work_item_persistence.sql" }])
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
  assert.deepEqual([...rows], [{ version: "001_work_item_persistence.sql" }])
})
