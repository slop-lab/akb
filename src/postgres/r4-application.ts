import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import { createR4CommandRouter } from "../http/command-v1/router.ts"
import { createEntityEventRouter } from "../http/entity-event-router.ts"
import {
  createR4ExportRouter,
  createR4HumanRouter,
  createR4ImportRouter,
} from "../http/human-v1/index.ts"
import { createR4SearchRouter } from "../http/human-v1/search-router.ts"
import { createR4ImportDispatcher } from "../import-export/command-dispatcher.ts"
import { eventId, workItemId } from "../work-items/identifiers.ts"
import { createAuthenticatedPostgresServer } from "./authenticated-server.ts"
import { createPostgresClient, databaseUrlFromEnvironment } from "./client.ts"

const RuntimeConfigSchema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  R4_CURSOR_SIGNING_KEY: z.string().min(43),
})

export type R4Application = {
  readonly server: Server
  readonly sql: Sql
  readonly host: string
  readonly port: number
}

export function createR4Application(environment: NodeJS.ProcessEnv): R4Application {
  const runtime = RuntimeConfigSchema.parse(environment)
  const signingKey = Buffer.from(runtime.R4_CURSOR_SIGNING_KEY, "base64url")
  if (signingKey.byteLength < 32)
    throw new RangeError("R4_CURSOR_SIGNING_KEY must decode to at least 32 bytes")
  const sql = createPostgresClient(databaseUrlFromEnvironment(environment))
  const dependencies = {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => new Date().toISOString(),
  }
  const routes = [
    createEntityEventRouter(sql),
    createR4ExportRouter(sql),
    createR4SearchRouter(sql, signingKey),
    createR4HumanRouter(sql, signingKey),
    createR4ImportRouter(sql, signingKey, createR4ImportDispatcher()),
    createR4CommandRouter(sql),
  ]
  return {
    server: createAuthenticatedPostgresServer(sql, dependencies, routes),
    sql,
    host: runtime.HOST,
    port: runtime.PORT,
  }
}
