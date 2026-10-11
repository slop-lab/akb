import type { Server } from "node:http"
import { createR4CommandRouter } from "../src/http/command-v1/router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import type { UnmigratedPostgresTestFixture } from "./postgres-fixture.ts"

export type CommandResponse = {
  readonly status: number
  readonly body: unknown
}

export type R4CommandApi = {
  readonly send: (
    path: string,
    method: "POST" | "PATCH" | "PUT",
    baseRevision: number | null,
    payload: unknown,
    key: string,
  ) => Promise<CommandResponse>
  readonly sendWithToken: (
    token: string,
    path: string,
    method: "POST" | "PATCH" | "PUT",
    baseRevision: number | null,
    payload: unknown,
    key: string,
  ) => Promise<CommandResponse>
  readonly patchLegacyWork: (
    workId: string,
    baseRevision: number,
    title: string,
  ) => Promise<CommandResponse>
  readonly close: () => Promise<void>
}

export async function startR4CommandApi(
  fixture: UnmigratedPostgresTestFixture,
): Promise<R4CommandApi> {
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  let legacyId = 0
  const server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId(`legacy-${++legacyId}`),
      newEventId: () => eventId(`legacy-event-${legacyId}`),
      now: () => "2026-01-02T03:04:05.000Z",
    },
    [createR4CommandRouter(fixture.sql)],
  )
  await listen(server)
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new TypeError("HTTP address unavailable")
  const origin = `http://127.0.0.1:${address.port}`
  const base = `${origin}/api/commands/v1/workspaces/w`
  const send = async (
    token: string,
    path: string,
    method: "POST" | "PATCH" | "PUT",
    baseRevision: number | null,
    payload: unknown,
    key: string,
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `command-${key}`,
        idempotencyKey: key,
        baseRevision,
        payload,
      }),
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    send: (path, method, revision, payload, key) =>
      send(issued.token, path, method, revision, payload, key),
    sendWithToken: send,
    patchLegacyWork: async (workId, baseRevision, title) => {
      const response = await fetch(`${origin}/api/work-items/${workId}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
        body: JSON.stringify({ actorId: "owner", baseRevision, title }),
      })
      return { status: response.status, body: await response.json() }
    },
    close: () => close(server),
  }
}

export function commandResult(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !isRecord(value["result"])) {
    throw new TypeError("response is not a command result")
  }
  return value["result"]
}

export function resultId(value: unknown): string {
  const id = commandResult(value)["id"]
  if (typeof id !== "string") throw new TypeError("command result has no ID")
  return id
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}
