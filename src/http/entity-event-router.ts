import type { Sql } from "postgres"
import type { z } from "zod"
import { EntityEventReader } from "../events/entity-reader.ts"
import { ReplayQuerySchema } from "../events/replay-query.ts"
import type { AuthenticatedRoute } from "./command-v1/router.ts"
import { parsePathSegment } from "./path-segment.ts"
import { invalidArgument, writeJson } from "./responses.ts"
import { WorkspacePathSchema } from "./schemas.ts"

export function createEntityEventRouter(sql: Sql): AuthenticatedRoute {
  return async (request, response, principal) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const match = /^\/api\/events\/v1\/workspaces\/([^/]+)\/events$/.exec(url.pathname)
    if (match === null || request.method !== "GET") return false
    const workspace = parsePathSegment(match[1], "workspaceId", WorkspacePathSchema)
    if (workspace.kind === "invalid") {
      invalidArgument(response, workspace.fieldErrors)
      return true
    }
    const values: Record<string, string | string[]> = {}
    for (const key of url.searchParams.keys()) {
      const entries = url.searchParams.getAll(key)
      values[key] = entries.length === 1 ? (entries[0] ?? "") : entries
    }
    const query = ReplayQuerySchema.safeParse(values)
    if (!query.success) {
      invalidArgument(response, query.error.issues.map(issueToFieldError))
      return true
    }
    const page = await new EntityEventReader(sql, principal).read(
      workspace.value,
      query.data.after,
      query.data.limit,
    )
    writeJson(response, 200, page)
    return true
  }
}

function issueToFieldError(issue: z.core.$ZodIssue): {
  readonly field: string
  readonly message: string
} {
  return { field: `query.${issue.path.join(".")}`, message: issue.message }
}
