import type { IncomingMessage, ServerResponse } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import {
  type ImportCommandDispatcher,
  ImportConflictError,
  ImportService,
  ImportValidationError,
} from "../../import-export/import-service.ts"
import { markResponseError } from "../request-telemetry.ts"
import { RequestBodyError, readBody } from "./body.ts"
import type { AuthenticatedRoute } from "./human-router.ts"

const CommandIdHeaderSchema = z.string().uuid()
const IdempotencyHeaderSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[!-~]+$/)

export function createR4ImportRouter(
  sql: Sql,
  signingKey: Uint8Array,
  dispatcher: ImportCommandDispatcher,
): AuthenticatedRoute {
  const imports = new ImportService(sql, signingKey, dispatcher)
  return async (request, response, principal) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const match = /^\/api\/commands\/v1\/workspaces\/([^/]+)\/imports$/.exec(url.pathname)
    if (match === null || request.method !== "POST") return false
    if (decodeURIComponent(match[1] ?? "") !== principal.workspaceId) {
      write(response, 404, { error: { code: "not_found" } })
      return true
    }
    try {
      if (singleHeader(request, "content-type") !== "application/x-ndjson") {
        throw new ImportValidationError("invalid content-type")
      }
      const body = await readBody(request, 10 * 1024 * 1024)
      const mode = z.enum(["validate", "commit"]).parse(url.searchParams.get("mode"))
      const binding = {
        commandId: CommandIdHeaderSchema.parse(singleHeader(request, "command-id")),
        idempotencyKey: IdempotencyHeaderSchema.parse(singleHeader(request, "idempotency-key")),
      }
      if (mode === "validate") {
        write(response, 200, await imports.validate(principal, body, binding))
        return true
      }
      const token = singleHeader(request, "validation-token")
      write(response, 200, await imports.commit(principal, body, token, binding))
      return true
    } catch (error) {
      if (error instanceof ImportConflictError) {
        write(response, 409, { error: { code: "import_conflict" } })
        return true
      }
      if (
        error instanceof ImportValidationError ||
        error instanceof RequestBodyError ||
        error instanceof z.ZodError ||
        error instanceof SyntaxError
      ) {
        write(response, 400, { error: { code: "invalid_import" } })
        return true
      }
      throw error
    }
  }
}

function singleHeader(request: IncomingMessage, name: string): string {
  const values: string[] = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      const value = request.rawHeaders[index + 1]
      if (value !== undefined) values.push(value)
    }
  }
  if (values.length !== 1 || values[0] === "") throw new ImportValidationError(`invalid ${name}`)
  return values[0] ?? ""
}

function write(response: ServerResponse, status: number, body: unknown): void {
  if (status >= 400) {
    const code =
      typeof body === "object" && body !== null
        ? Reflect.get(Reflect.get(body, "error") ?? {}, "code")
        : undefined
    markResponseError(response, typeof code === "string" ? code : "request_failed")
  }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(body))
}
