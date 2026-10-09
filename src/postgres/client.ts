import postgres, { type Sql } from "postgres"
import { z } from "zod"

const DatabaseUrlSchema = z
  .string()
  .url()
  .refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
    message: "DATABASE_URL must use postgres:// or postgresql://",
  })
const DatabaseEnvironmentSchema = z.object({ DATABASE_URL: DatabaseUrlSchema })
const DatabaseSchemaNameSchema = z
  .string()
  .regex(/^[a-z_][a-z0-9_]{0,62}$/)
  .brand("DatabaseSchemaName")

export type DatabaseSchemaName = z.infer<typeof DatabaseSchemaNameSchema>

export type PostgresClientConfig = {
  readonly maxConnections?: number
  readonly schema?: DatabaseSchemaName
}

export function databaseUrlFromEnvironment(environment: NodeJS.ProcessEnv): string {
  return DatabaseEnvironmentSchema.parse(environment).DATABASE_URL
}

export function databaseSchemaName(value: string): DatabaseSchemaName {
  return DatabaseSchemaNameSchema.parse(value)
}

export function createPostgresClient(databaseUrl: string, config: PostgresClientConfig = {}): Sql {
  return postgres(DatabaseUrlSchema.parse(databaseUrl), {
    max: config.maxConnections ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      statement_timeout: 5_000,
      lock_timeout: 2_000,
      ...(config.schema === undefined ? {} : { search_path: config.schema }),
    },
  })
}
