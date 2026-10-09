import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import { eventId, workItemId } from "../work-items/identifiers.ts"
import { createAuthenticatedPostgresServer } from "./authenticated-server.ts"
import { createPostgresClient, databaseUrlFromEnvironment } from "./client.ts"

const RuntimeConfigSchema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
})

export type PostgresApplication = {
  readonly server: Server
  readonly sql: Sql
  readonly host: string
  readonly port: number
}

export function createPostgresApplication(environment: NodeJS.ProcessEnv): PostgresApplication {
  const runtime = RuntimeConfigSchema.parse(environment)
  const sql = createPostgresClient(databaseUrlFromEnvironment(environment))
  const dependencies = {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => new Date().toISOString(),
  }
  return {
    server: createAuthenticatedPostgresServer(sql, dependencies),
    sql,
    host: runtime.HOST,
    port: runtime.PORT,
  }
}
