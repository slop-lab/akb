import type { IncomingMessage, ServerResponse } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import { CommandEnvelopeSchema } from "../../contracts/r4/command.ts"
import {
  CommandIdempotencyConflictError,
  CommandInvariantError,
  EntityNotFoundError,
  EntityRevisionConflictError,
} from "../../entities/errors.ts"
import type { AuthenticatedPrincipal } from "../../identity/types.ts"
import { R4CommandService } from "../../pm/commands/service.ts"
import type { CommandExecutor } from "../../pm/commands/types.ts"
import { readJson, RequestBodyError } from "../human-v1/body.ts"
import { invalidArgument, writeJson } from "../responses.ts"
import { COMMAND_ROUTES, type CommandRoute } from "./routes.ts"

export type AuthenticatedRoute = (
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthenticatedPrincipal,
) => Promise<boolean>

export function createR4CommandRouter(
  sql: Sql,
  dependencies: { readonly executor?: CommandExecutor } = {},
): AuthenticatedRoute {
  const executor = dependencies.executor ?? new R4CommandService(sql)
  return async (request, response, principal) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    const matched = matchRoute(request.method ?? "", pathname)
    if (matched === undefined) return false
    try {
      const raw = await readJson(request, 64 * 1024)
      const envelope = CommandEnvelopeSchema.parse(raw)
      const payload = matched.route.payload.parse(envelope.payload)
      if (
        (matched.route.create && envelope.baseRevision !== null) ||
        (!matched.route.create && envelope.baseRevision === null)
      ) {
        invalidArgument(response, [
          {
            field: "baseRevision",
            message: matched.route.create
              ? "create commands require null"
              : "mutation commands require a revision",
          },
        ])
        return true
      }
      const workspaceId = decode(matched.captures[1])
      const parentId = capture(matched, matched.route.parentCapture)
      const resourceId = capture(matched, matched.route.resourceCapture)
      const result = await executor.execute({
        workspaceId,
        principal,
        commandId: envelope.commandId,
        idempotencyKey: envelope.idempotencyKey,
        baseRevision: envelope.baseRevision,
        action: matched.route.action,
        route: matched.route.pattern.source,
        resourceId,
        parentId,
        payload,
      })
      writeJson(response, result.replayed ? 200 : matched.route.create ? 201 : 200, result)
    } catch (error) {
      writeCommandError(response, error)
    }
    return true
  }
}

function matchRoute(
  method: string,
  pathname: string,
): { readonly route: CommandRoute; readonly captures: RegExpExecArray } | undefined {
  for (const route of COMMAND_ROUTES) {
    if (route.method !== method) continue
    const captures = route.pattern.exec(pathname)
    if (captures !== null) return { route, captures }
  }
  return undefined
}

function capture(
  matched: { readonly route: CommandRoute; readonly captures: RegExpExecArray },
  index: number | undefined,
): string | null {
  if (index === undefined) return null
  return decode(matched.captures[index])
}

function decode(value: string | undefined): string {
  if (value === undefined) throw new URIError("path capture is missing")
  const decoded = decodeURIComponent(value)
  if (decoded.includes("/") || decoded.includes("\\") || decoded.trim().length === 0) {
    throw new URIError("path segment is invalid")
  }
  return decoded
}

function writeCommandError(response: ServerResponse, error: unknown): void {
  if (
    error instanceof z.ZodError ||
    error instanceof SyntaxError ||
    error instanceof URIError ||
    error instanceof RequestBodyError
  ) {
    const fieldErrors =
      error instanceof z.ZodError
        ? error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message }))
        : [{ field: "request", message: error.message }]
    invalidArgument(response, fieldErrors)
    return
  }
  if (error instanceof EntityNotFoundError) {
    writeJson(response, 404, {
      error: { code: "not_found", message: "entity was not found", retryable: false, details: {} },
    })
    return
  }
  if (error instanceof EntityRevisionConflictError) {
    writeJson(response, 409, {
      error: {
        code: "revision_conflict",
        message: error.message,
        retryable: false,
        details: { expected: error.expected, actual: error.actual },
      },
    })
    return
  }
  if (error instanceof CommandIdempotencyConflictError) {
    writeJson(response, 409, {
      error: {
        code: "idempotency_conflict",
        message: error.message,
        retryable: false,
        details: { idempotencyKey: error.idempotencyKey },
      },
    })
    return
  }
  if (error instanceof CommandInvariantError) {
    writeJson(response, 409, {
      error: { code: error.code, message: error.message, retryable: false, details: {} },
    })
    return
  }
  throw error
}
