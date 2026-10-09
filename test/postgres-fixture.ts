import { randomUUID } from "node:crypto"
import type { Sql } from "postgres"
import { z } from "zod"
import {
  createPostgresClient,
  databaseSchemaName,
  databaseUrlFromEnvironment,
  type DatabaseSchemaName,
} from "../src/postgres/client.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"

const OwnedSchemaNameSchema = z
  .string()
  .regex(/^test_[0-9a-f]{32}$/)
  .transform(databaseSchemaName)

export type PostgresTestFixture = {
  readonly sql: Sql
  readonly connect: () => Sql
  readonly reset: () => Promise<void>
  readonly close: () => Promise<void>
}

export type UnmigratedPostgresTestFixture = Omit<PostgresTestFixture, "reset">

export async function createUnmigratedPostgresTestFixture(): Promise<UnmigratedPostgresTestFixture> {
  const databaseUrl = databaseUrlFromEnvironment(process.env)
  const schema = OwnedSchemaNameSchema.parse(`test_${randomUUID().replaceAll("-", "")}`)
  const admin = createPostgresClient(databaseUrl, { maxConnections: 2 })
  await admin`create schema ${admin(schema)}`
  const connect = () => createPostgresClient(databaseUrl, { maxConnections: 10, schema })
  const sql = connect()
  return {
    sql,
    connect,
    close: async () => {
      await sql.end()
      await dropOwnedSchema(admin, schema)
      await admin.end()
    },
  }
}

export async function createPostgresTestFixture(): Promise<PostgresTestFixture> {
  const fixture = await createUnmigratedPostgresTestFixture()
  try {
    await migrateDatabase(fixture.sql)
  } catch (error) {
    await fixture.close()
    throw error
  }
  return {
    ...fixture,
    reset: async () => {
      await fixture.sql`truncate principal_credentials, membership_permissions,
        workspace_memberships, principals, workspaces, work_item_idempotency, domain_events,
        work_item_revisions, work_items, workspace_event_sequences`
    },
  }
}

async function dropOwnedSchema(admin: Sql, schema: DatabaseSchemaName): Promise<void> {
  await admin`drop schema ${admin(schema)} cascade`
}
