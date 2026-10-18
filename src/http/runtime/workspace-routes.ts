import type { IncomingMessage, ServerResponse } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import {
  CreateDefinitionInputSchema,
  CreateInstallationInputSchema,
  CreateRuntimeEndpointInputSchema,
  ResumeRunInputSchema,
  StartRunInputSchema,
} from "../../contracts/runtime/index.ts"
import type { AuthenticatedPrincipal } from "../../identity/types.ts"
import { RuntimeControl } from "../../runtime/control.ts"
import { RuntimeConflictError, RuntimeNotFoundError } from "../../runtime/errors.ts"
import { RuntimeRegistry } from "../../runtime/registry.ts"
import { RequestBodyError, readJson } from "../human-v1/body.ts"
import { writeJson } from "../responses.ts"

export type RuntimeAuthenticatedRoute = (
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthenticatedPrincipal,
) => Promise<boolean>

export function createRuntimeWorkspaceRoutes(
  sql: Sql,
  signingKey: Uint8Array,
): readonly RuntimeAuthenticatedRoute[] {
  if (signingKey.byteLength < 32) throw new RangeError("runtime signing key requires 32 bytes")
  const registry = new RuntimeRegistry(sql)
  const control = new RuntimeControl(sql)
  return [
    async (request, response, principal) => {
      const url = new URL(request.url ?? "/", "http://localhost")
      const match = /^\/api\/runtime\/v1\/workspaces\/([^/]+)(\/.*)$/.exec(url.pathname)
      if (match === null) return false
      let workspaceId: string
      try {
        workspaceId = decodeURIComponent(match[1] ?? "")
      } catch {
        writeRuntimeError(response, 400, "invalid_argument")
        return true
      }
      if (workspaceId !== principal.workspaceId) {
        writeRuntimeError(response, 404, "not_found")
        return true
      }
      const path = match[2] ?? "/"
      try {
        if (request.method === "POST" && path === "/definitions") {
          const input = CreateDefinitionInputSchema.parse(await readJson(request, 256 * 1024))
          writeJson(response, 201, await registry.createDefinition(principal, input))
          return true
        }
        if (request.method === "POST" && path === "/endpoints") {
          const input = CreateRuntimeEndpointInputSchema.parse(await readJson(request, 64 * 1024))
          writeJson(response, 201, await registry.createEndpoint(principal, input))
          return true
        }
        if (request.method === "POST" && path === "/installations") {
          const input = CreateInstallationInputSchema.parse(await readJson(request, 128 * 1024))
          writeJson(response, 201, await registry.createInstallation(principal, input))
          return true
        }
        if (request.method === "POST" && path === "/runs") {
          const input = StartRunInputSchema.parse(await readJson(request, 64 * 1024))
          writeJson(response, 201, await control.start(principal, input))
          return true
        }
        const run = /^\/runs\/([^/]+)$/.exec(path)
        if (request.method === "GET" && run !== null) {
          writeJson(response, 200, await control.inspect(principal, segment(run[1])))
          return true
        }
        const cancel = /^\/runs\/([^/]+)\/cancel$/.exec(path)
        if (request.method === "POST" && cancel !== null) {
          await readJson(request, 1024)
          await control.cancel(principal, segment(cancel[1]))
          writeJson(response, 200, { state: "canceled" })
          return true
        }
        const resume = /^\/runs\/([^/]+)\/resume$/.exec(path)
        if (request.method === "POST" && resume !== null) {
          const input = ResumeRunInputSchema.parse(await readJson(request, 64 * 1024))
          writeJson(
            response,
            200,
            await control.resume(
              principal,
              segment(resume[1]),
              input.input === undefined
                ? { idempotencyKey: input.idempotencyKey }
                : { idempotencyKey: input.idempotencyKey, input: input.input },
            ),
          )
          return true
        }
        writeRuntimeError(response, 404, "not_found")
      } catch (error) {
        handleRuntimeError(response, error)
      }
      return true
    },
  ]
}

function segment(value: string | undefined): string {
  if (value === undefined) throw new URIError("path segment is missing")
  return decodeURIComponent(value)
}

function handleRuntimeError(response: ServerResponse, error: unknown): void {
  if (
    error instanceof z.ZodError ||
    error instanceof SyntaxError ||
    error instanceof URIError ||
    error instanceof RequestBodyError
  ) {
    writeRuntimeError(response, 400, "invalid_argument")
    return
  }
  if (error instanceof RuntimeNotFoundError) {
    writeRuntimeError(response, 404, "not_found")
    return
  }
  if (error instanceof RuntimeConflictError) {
    writeRuntimeError(response, 409, error.code)
    return
  }
  throw error
}

function writeRuntimeError(response: ServerResponse, status: number, code: string): void {
  writeJson(response, status, { error: { code, message: code, retryable: false, details: {} } })
}
