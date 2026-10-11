import type { IncomingMessage } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import { SearchPageSchema, SearchRequestPagedSchema } from "../../contracts/r4/search.ts"
import { QueryBudgetExceededError, SnapshotConflictError } from "../../human-query/service.ts"
import { WorkspaceNotFoundError } from "../../identity/authorization-errors.ts"
import { createPostgresSearch } from "../../search/postgres-search.ts"
import { InvalidCursorError } from "../../search/search-binding.ts"
import type { R4SearchQuery } from "../../search/types.ts"
import type { AuthenticatedRoute } from "../command-v1/router.ts"
import { invalidArgument, writeJson } from "../responses.ts"
import { RequestBodyError, readJson } from "./body.ts"

export type R4SearchRouteFactory = (sql: Sql, signingKey: Uint8Array) => AuthenticatedRoute

export const createR4SearchRouter: R4SearchRouteFactory = (sql, signingKey) => {
  const search = createPostgresSearch(sql, signingKey)
  return createSearchRoute(search)
}

export function createSearchRoute(search: R4SearchQuery): AuthenticatedRoute {
  return async (request, response, principal) => {
    const matched = match(request)
    if (matched === undefined) return false
    try {
      const workspaceId = decode(matched)
      if (workspaceId !== principal.workspaceId) throw new WorkspaceNotFoundError()
      const input = SearchRequestPagedSchema.parse(await readJson(request, 64 * 1024))
      const page = await search.search(principal, workspaceId, input)
      writeJson(response, 200, SearchPageSchema.parse(page))
    } catch (error) {
      if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof URIError ||
        error instanceof RequestBodyError ||
        error instanceof InvalidCursorError
      ) {
        invalidArgument(response, [{ field: "request", message: "request is invalid" }])
      } else if (error instanceof SnapshotConflictError) {
        writeJson(response, error.code === "snapshot_expired" ? 410 : 409, {
          error: { code: error.code, message: error.code, retryable: false, details: {} },
        })
      } else if (error instanceof QueryBudgetExceededError) {
        writeJson(response, 507, {
          error: {
            code: "query_budget_exceeded",
            message: "query_budget_exceeded",
            retryable: false,
            details: {},
          },
        })
      } else {
        throw error
      }
    }
    return true
  }
}

function match(request: IncomingMessage): string | undefined {
  if (request.method !== "POST") return undefined
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname
  return /^\/api\/human\/v1\/workspaces\/([^/]+)\/search$/.exec(pathname)?.[1]
}

function decode(value: string): string {
  const decoded = decodeURIComponent(value)
  if (decoded.trim().length === 0 || decoded.includes("/") || decoded.includes("\\")) {
    throw new URIError("invalid workspace path segment")
  }
  return decoded
}
