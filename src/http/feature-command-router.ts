import type { Sql } from "postgres"
import { type ZodType, z } from "zod"
import { CommandEnvelopeSchema } from "../contracts/r4/command.ts"
import type { BatchMutationResult } from "../entities/command-unit-of-work.ts"
import {
  CommandIdempotencyConflictError,
  CommandInvariantError,
  EntityNotFoundError,
  EntityRevisionConflictError,
} from "../entities/errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { RequestBodyError, readJson } from "./human-v1/body.ts"
import { invalidArgument, writeJson } from "./responses.ts"
import type { WorkspaceAuthenticatedRoute } from "./route-types.ts"

export type FeatureCommandRoute<Action extends string> = {
  readonly method: "POST" | "PATCH" | "PUT"
  readonly pattern: RegExp
  readonly action: Action
  readonly payload: ZodType
  readonly create: boolean
  readonly parentCapture?: number
  readonly resourceCapture?: number
}

export type FeatureCommandCall<Action extends string> = {
  readonly workspaceId: string
  readonly principal: AuthenticatedPrincipal
  readonly commandId: string
  readonly idempotencyKey: string
  readonly baseRevision: number | null
  readonly action: Action
  readonly route: string
  readonly resourceId: string | null
  readonly parentId: string | null
  readonly payload: unknown
}

export interface FeatureCommandExecutor<Action extends string> {
  execute(call: FeatureCommandCall<Action>): Promise<BatchMutationResult>
}

export function featureCommandRoute<Action extends string>(
  route: FeatureCommandRoute<Action>,
): FeatureCommandRoute<Action> {
  return route
}

export function createFeatureCommandRouter<Action extends string>(
  sql: Sql,
  routes: readonly FeatureCommandRoute<Action>[],
  executor: FeatureCommandExecutor<Action>,
): WorkspaceAuthenticatedRoute {
  void sql
  return async (request, response, principal) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    const matched = matchRoute(request.method ?? "", pathname, routes)
    if (matched === undefined) return false
    try {
      const envelope = CommandEnvelopeSchema.parse(await readJson(request, 64 * 1024))
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
      const result = await executor.execute({
        workspaceId: decode(matched.captures[1]),
        principal,
        commandId: envelope.commandId,
        idempotencyKey: envelope.idempotencyKey,
        baseRevision: envelope.baseRevision,
        action: matched.route.action,
        route: matched.route.pattern.source,
        resourceId: capture(matched, matched.route.resourceCapture),
        parentId: capture(matched, matched.route.parentCapture),
        payload,
      })
      writeJson(response, result.replayed ? 200 : matched.route.create ? 201 : 200, result)
    } catch (error) {
      writeFeatureCommandError(response, error)
    }
    return true
  }
}

type MatchedRoute<Action extends string> = {
  readonly route: FeatureCommandRoute<Action>
  readonly captures: RegExpExecArray
}

function matchRoute<Action extends string>(
  method: string,
  pathname: string,
  routes: readonly FeatureCommandRoute<Action>[],
): MatchedRoute<Action> | undefined {
  for (const route of routes) {
    if (route.method !== method) continue
    const captures = route.pattern.exec(pathname)
    if (captures !== null) return { route, captures }
  }
  return undefined
}

function capture<Action extends string>(
  matched: MatchedRoute<Action>,
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

function writeFeatureCommandError(
  response: Parameters<WorkspaceAuthenticatedRoute>[1],
  error: unknown,
): void {
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
    writeJson(response, 404, publicError("not_found", error.message, {}))
    return
  }
  if (error instanceof EntityRevisionConflictError) {
    writeJson(
      response,
      409,
      publicError("revision_conflict", error.message, {
        expected: error.expected,
        actual: error.actual,
      }),
    )
    return
  }
  if (error instanceof CommandIdempotencyConflictError) {
    writeJson(
      response,
      409,
      publicError("idempotency_conflict", error.message, {
        idempotencyKey: error.idempotencyKey,
      }),
    )
    return
  }
  if (error instanceof CommandInvariantError) {
    writeJson(response, 409, publicError(error.code, error.message, {}))
    return
  }
  throw error
}

function publicError(
  code: string,
  message: string,
  details: Readonly<Record<string, string | number>>,
): Readonly<Record<string, unknown>> {
  return { error: { code, message, retryable: false, details } }
}
