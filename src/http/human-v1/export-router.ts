import type { ServerResponse } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import { ExportRequestSchema } from "../../contracts/r4/index.ts"
import {
  ExportValidationError,
  exportAuthorizedProject,
} from "../../import-export/export-service.ts"
import { RequestBodyError, readJson } from "./body.ts"
import type { AuthenticatedRoute } from "./human-router.ts"

export function createR4ExportRouter(sql: Sql): AuthenticatedRoute {
  return async (request, response, principal) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const match = /^\/api\/human\/v1\/workspaces\/([^/]+)\/export$/.exec(url.pathname)
    if (match === null || request.method !== "POST") return false
    if (decodeURIComponent(match[1] ?? "") !== principal.workspaceId) {
      writeError(response, 404, "not_found")
      return true
    }
    try {
      const options = ExportRequestSchema.parse(await readJson(request))
      const output = await exportAuthorizedProject(sql, principal, options)
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-length": Buffer.byteLength(output),
      })
      response.end(output)
    } catch (error) {
      if (error instanceof ExportValidationError) {
        writeError(response, error.code === "not_found" ? 404 : 413, error.code)
      } else if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof RequestBodyError
      ) {
        writeError(response, 400, "invalid_argument")
      } else throw error
    }
    return true
  }
}

function writeError(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify({ error: { code, message: code, retryable: false, details: {} } }))
}
