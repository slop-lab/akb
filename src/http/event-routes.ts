import type { IncomingMessage, ServerResponse } from "node:http"
import type { z } from "zod"
import type { PostgresWorkspaceEventReader } from "../events/postgres-reader.ts"
import { ReplayQuerySchema } from "../events/replay-query.ts"
import { parsePathSegment } from "./path-segment.ts"
import { invalidArgument, writeJson } from "./responses.ts"
import { WorkspacePathSchema } from "./schemas.ts"

export async function routeWorkspaceEvents(
  request: IncomingMessage,
  response: ServerResponse,
  reader: PostgresWorkspaceEventReader,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost")
  const match = /^\/api\/workspaces\/([^/]+)\/events$/.exec(url.pathname)
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
  writeJson(response, 200, await reader.read(workspace.value, query.data.after, query.data.limit))
  return true
}

function issueToFieldError(issue: z.core.$ZodIssue): {
  readonly field: string
  readonly message: string
} {
  return { field: `query.${issue.path.join(".")}`, message: issue.message }
}
