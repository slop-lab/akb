import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { createServer } from "node:http"
import type { Sql } from "postgres"
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
  WorkspaceNotFoundError,
} from "../identity/authorization-errors.ts"
import { authenticateToken } from "../identity/authenticate.ts"
import {
  authenticationRequired,
  internalError,
  permissionDenied,
  routeNotFound,
  workspaceNotFound,
} from "../http/responses.ts"
import { routeWorkItems } from "../http/work-item-routes.ts"
import { AuthorizedPostgresWorkItemStore } from "../work-items/authorized-postgres-store.ts"
import type { StoreDependencies } from "../work-items/in-memory-store.ts"

const HEALTH_RESPONSE = JSON.stringify({ status: "ok" })

export function createAuthenticatedPostgresServer(
  sql: Sql,
  dependencies: StoreDependencies,
): Server {
  return createServer((request, response) => {
    handleAuthenticatedRequest(request, response, sql, dependencies).catch((error: unknown) => {
      if (response.headersSent || response.writableEnded) {
        response.destroy()
        return
      }
      if (error instanceof AuthenticationRequiredError) {
        authenticationRequired(response)
      } else if (error instanceof PermissionDeniedError) {
        permissionDenied(response)
      } else if (error instanceof WorkspaceNotFoundError) {
        workspaceNotFound(response)
      } else {
        internalError(response)
      }
    })
  })
}

async function handleAuthenticatedRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sql: Sql,
  dependencies: StoreDependencies,
): Promise<void> {
  const path = request.url?.split("?", 1)[0] ?? "/"
  if (request.method === "GET" && path === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
    response.end(HEALTH_RESPONSE)
    return
  }
  if (path.startsWith("/api/")) {
    const token = bearerToken(request)
    if (token === undefined) throw new AuthenticationRequiredError()
    const principal = await authenticateToken(sql, token)
    if (principal === undefined) throw new AuthenticationRequiredError()
    const store = new AuthorizedPostgresWorkItemStore(sql, principal, dependencies)
    if (await routeWorkItems(request, response, store)) return
  }
  routeNotFound(response, request.method ?? "UNKNOWN", path)
}

function bearerToken(request: IncomingMessage): string | undefined {
  const values: string[] = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "authorization") {
      const value = request.rawHeaders[index + 1]
      if (value !== undefined) values.push(value)
    }
  }
  if (values.length !== 1) return undefined
  const match = /^Bearer ([^ ]+)$/.exec(values[0] ?? "")
  return match?.[1]
}
