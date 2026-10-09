import type { ServerResponse } from "node:http"
import type { Revision } from "../work-items/identifiers.ts"
import type { CapacityExceeded } from "../work-items/model.ts"
import type { FieldError } from "./error-schemas.ts"

type ErrorDetails = Readonly<Record<string, string | number>>

export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(body))
}

export function invalidArgument(
  response: ServerResponse,
  fieldErrors: readonly FieldError[],
): void {
  writeJson(response, 400, {
    error: {
      code: "invalid_argument",
      message: "request arguments are invalid",
      retryable: false,
      fieldErrors,
    },
  })
}

export function notFound(response: ServerResponse, id: string): void {
  writeError(response, 404, "not_found", "work item was not found", { id })
}

export function idempotencyConflict(response: ServerResponse, key: string): void {
  writeError(
    response,
    409,
    "idempotency_conflict",
    "idempotency key was already used for a different command",
    { idempotencyKey: key },
  )
}

export function revisionConflict(
  response: ServerResponse,
  expected: Revision,
  actual: Revision,
): void {
  writeError(response, 409, "revision_conflict", "work item revision does not match", {
    expected,
    actual,
  })
}

export function budgetExceeded(response: ServerResponse, limit: number): void {
  writeError(response, 413, "budget_exceeded", "request body exceeds the byte limit", { limit })
}

export function capacityExceeded(response: ServerResponse, result: CapacityExceeded): void {
  writeError(response, 507, "budget_exceeded", "in-memory work item capacity is exhausted", {
    resource: result.resource,
    capacity: result.capacity,
  })
}

export function routeNotFound(response: ServerResponse, method: string, path: string): void {
  writeError(response, 404, "not_found", "route was not found", { method, path })
}

export function internalError(response: ServerResponse): void {
  writeError(response, 500, "internal", "internal server error", {})
}

export function authenticationRequired(response: ServerResponse): void {
  response.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "www-authenticate": "Bearer",
  })
  response.end(
    JSON.stringify({
      error: {
        code: "unauthenticated",
        message: "authentication required",
        retryable: false,
        details: {},
      },
    }),
  )
}

export function permissionDenied(response: ServerResponse): void {
  writeError(response, 403, "permission_denied", "permission denied", {})
}

export function workspaceNotFound(response: ServerResponse): void {
  writeError(response, 404, "not_found", "workspace was not found", {})
}

export function scopeNotFound(response: ServerResponse): void {
  writeError(response, 404, "not_found", "scope was not found", {})
}

function writeError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  details: ErrorDetails,
): void {
  writeJson(response, status, { error: { code, message, retryable: false, details } })
}
