import type { Sql } from "postgres"
import { z } from "zod"
import {
  ContextBudgetExceededError,
  InvalidContextSelectionError,
} from "../../content/workflow-errors.ts"
import { ContentWorkflowReadService } from "../../content/workflow-read-service.ts"
import { CONTENT_PAGE_TEMPLATES } from "../../contracts/content/templates.ts"
import {
  ContentDocumentDiscoveryQuerySchema,
  ContextReadRequestSchema,
} from "../../contracts/content/workflow.ts"
import { EntityNotFoundError } from "../../entities/errors.ts"
import { RequestBodyError, readJson } from "../human-v1/body.ts"
import { invalidArgument, writeJson } from "../responses.ts"
import type { WorkspaceAuthenticatedRoute } from "../route-types.ts"

const PREFIX = /^\/api\/content\/v1\/workspaces\/([^/]+)(\/.*)$/

export function createContentWorkflowRoute(sql: Sql): WorkspaceAuthenticatedRoute {
  const reads = new ContentWorkflowReadService(sql)
  return async (request, response, principal) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const matched = PREFIX.exec(url.pathname)
    if (matched === null) return false
    const path = matched[2]
    if (path !== "/templates" && path !== "/documents" && path !== "/context") return false
    response.setHeader("cache-control", "no-store")
    try {
      const workspaceId = segment(matched[1])
      if (request.method === "GET" && path === "/templates") {
        await reads.templates(principal, workspaceId)
        writeJson(response, 200, { templates: CONTENT_PAGE_TEMPLATES })
        return true
      }
      if (request.method === "GET" && path === "/documents") {
        const query = ContentDocumentDiscoveryQuerySchema.parse(
          Object.fromEntries(url.searchParams),
        )
        writeJson(response, 200, await reads.discover(principal, workspaceId, query))
        return true
      }
      if (request.method === "POST" && path === "/context") {
        const body = ContextReadRequestSchema.parse(await readJson(request, 64 * 1024))
        writeJson(response, 200, await reads.context(principal, workspaceId, body))
        return true
      }
      return false
    } catch (error) {
      if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof URIError ||
        error instanceof RequestBodyError
      ) {
        invalidArgument(response, [{ field: "request", message: "request is invalid" }])
        return true
      }
      if (error instanceof EntityNotFoundError) {
        writeError(response, 404, "not_found")
        return true
      }
      if (error instanceof InvalidContextSelectionError) {
        writeError(response, 422, "invalid_context_selection")
        return true
      }
      if (error instanceof ContextBudgetExceededError) {
        writeError(response, 422, "context_budget_exceeded")
        return true
      }
      throw error
    }
  }
}

function segment(value: string | undefined): string {
  if (value === undefined) throw new URIError("missing path segment")
  const decoded = decodeURIComponent(value)
  if (decoded.length === 0 || decoded.includes("/") || decoded.includes("\\")) {
    throw new URIError("invalid path segment")
  }
  return decoded
}

function writeError(response: Parameters<typeof writeJson>[0], status: number, code: string): void {
  writeJson(response, status, {
    error: { code, message: code, retryable: false, details: {} },
  })
}
