import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { z } from "zod"
import { createR4CommandRouter } from "../src/http/command-v1/router.ts"
import { createR4ExportRouter } from "../src/http/human-v1/export-router.ts"
import { createR4ImportRouter } from "../src/http/human-v1/import-router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createR4ImportDispatcher } from "../src/import-export/command-dispatcher.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createUnmigratedPostgresTestFixture } from "./postgres-fixture.ts"

export async function createInterchangeHttpFixture() {
  const database = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(database.sql)
  const issued = await new IdentityAdmin(database.sql).bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const server = createAuthenticatedPostgresServer(
    database.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-12T00:00:00.000Z",
    },
    [
      createR4CommandRouter(database.sql),
      createR4ExportRouter(database.sql),
      createR4ImportRouter(database.sql, Buffer.alloc(32, 23), createR4ImportDispatcher()),
    ],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("server did not listen")
  const base = `http://127.0.0.1:${(address satisfies AddressInfo).port}`
  const request = (path: string, init: RequestInit) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${issued.token}`, ...init.headers },
    })
  return {
    sql: database.sql,
    request,
    close: async () => {
      await close(server)
      await database.close()
    },
  }
}

export async function validateAndCommit(
  request: (path: string, init: RequestInit) => Promise<Response>,
  bytes: string,
  key: string,
) {
  const headers = {
    "content-type": "application/x-ndjson",
    "command-id": key,
    "idempotency-key": key,
  }
  const validated = await request("/api/commands/v1/workspaces/w/imports?mode=validate", {
    method: "POST",
    headers,
    body: bytes,
  })
  if (validated.status !== 200) return { validated, commit: null }
  const body = z.object({ validationToken: z.string() }).parse(await validated.json())
  const commit = await request("/api/commands/v1/workspaces/w/imports?mode=commit", {
    method: "POST",
    headers: { ...headers, "validation-token": body.validationToken },
    body: bytes,
  })
  return { validated, commit }
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}
