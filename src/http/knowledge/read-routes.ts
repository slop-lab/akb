import type { IncomingMessage } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import { EntityNotFoundError } from "../../entities/errors.ts"
import { WorkspaceNotFoundError } from "../../identity/authorization-errors.ts"
import { KnowledgeReader } from "../../knowledge/reader.ts"
import { invalidArgument, writeJson } from "../responses.ts"
import type { WorkspaceAuthenticatedRoute } from "../route-types.ts"

const SearchQuerySchema = z.strictObject({
  query: z.string().max(500).default(""),
  includeSuperseded: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export function createKnowledgeReadRoute(sql: Sql): WorkspaceAuthenticatedRoute {
  return async (request, response, principal) => {
    const matched = match(request)
    if (matched === undefined) return false
    try {
      const reader = new KnowledgeReader(sql, principal)
      const workspaceId = decode(matched.workspaceId)
      switch (matched.kind) {
        case "get": {
          const object = await reader.get(workspaceId, decode(matched.knowledgeId))
          if (object === undefined) throw new EntityNotFoundError(matched.knowledgeId)
          writeJson(response, 200, object)
          break
        }
        case "history":
          writeJson(response, 200, await reader.history(workspaceId, decode(matched.knowledgeId)))
          break
        case "summaries":
          writeJson(response, 200, await reader.summaries(workspaceId, decode(matched.knowledgeId)))
          break
        case "search": {
          const url = new URL(request.url ?? "/", "http://localhost")
          const query = SearchQuerySchema.parse(Object.fromEntries(url.searchParams))
          writeJson(
            response,
            200,
            await reader.search(workspaceId, query.query, query.includeSuperseded, query.limit),
          )
          break
        }
        default:
          assertNever(matched)
      }
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof URIError) {
        invalidArgument(response, [{ field: "request", message: "request is invalid" }])
      } else if (error instanceof EntityNotFoundError || error instanceof WorkspaceNotFoundError) {
        writeJson(response, 404, {
          error: { code: "not_found", message: "not found", retryable: false, details: {} },
        })
      } else {
        throw error
      }
    }
    return true
  }
}

type ReadMatch =
  | { readonly kind: "get"; readonly workspaceId: string; readonly knowledgeId: string }
  | { readonly kind: "history"; readonly workspaceId: string; readonly knowledgeId: string }
  | { readonly kind: "summaries"; readonly workspaceId: string; readonly knowledgeId: string }
  | { readonly kind: "search"; readonly workspaceId: string }

function match(request: IncomingMessage): ReadMatch | undefined {
  if (request.method !== "GET") return undefined
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname
  const history = /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/objects\/([^/]+)\/history$/.exec(
    pathname,
  )
  if (history !== null)
    return { kind: "history", workspaceId: required(history[1]), knowledgeId: required(history[2]) }
  const summaries = /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/objects\/([^/]+)\/summaries$/.exec(
    pathname,
  )
  if (summaries !== null)
    return {
      kind: "summaries",
      workspaceId: required(summaries[1]),
      knowledgeId: required(summaries[2]),
    }
  const object = /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/objects\/([^/]+)$/.exec(pathname)
  if (object !== null)
    return { kind: "get", workspaceId: required(object[1]), knowledgeId: required(object[2]) }
  const search = /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/objects$/.exec(pathname)
  return search === null ? undefined : { kind: "search", workspaceId: required(search[1]) }
}

function decode(value: string): string {
  const decoded = decodeURIComponent(value)
  if (decoded.trim().length === 0 || decoded.includes("/") || decoded.includes("\\"))
    throw new URIError("invalid path")
  return decoded
}
function required(value: string | undefined): string {
  if (value === undefined) throw new URIError("path capture missing")
  return value
}
function assertNever(value: never): never {
  throw new TypeError(`unsupported knowledge read: ${JSON.stringify(value)}`)
}
