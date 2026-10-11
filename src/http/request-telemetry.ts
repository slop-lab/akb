import { randomUUID } from "node:crypto"
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http"
import { COMMAND_ROUTES } from "./command-v1/routes.ts"

export type RequestTelemetry = {
  readonly timestamp: string
  readonly level: "info" | "error"
  readonly event: "http.request"
  readonly requestId: string
  readonly method: string
  readonly routeTemplate: string
  readonly status: number
  readonly durationMs: number
  readonly bytes: number
  readonly errorCode: string | null
}

type TelemetryDependencies = {
  readonly sink?: (event: RequestTelemetry) => void
  readonly now?: () => string
  readonly newRequestId?: () => string
}

const responseErrors = new WeakMap<ServerResponse, string>()

export function markResponseError(response: ServerResponse, code: string): void {
  responseErrors.set(response, code)
}

export function createRequestTelemetryHandler(
  next: RequestListener,
  dependencies: TelemetryDependencies = {},
): RequestListener {
  const sink = dependencies.sink ?? ((event) => process.stdout.write(`${JSON.stringify(event)}\n`))
  const now = dependencies.now ?? (() => new Date().toISOString())
  const newRequestId = dependencies.newRequestId ?? randomUUID
  return (request, response) => {
    const startedAt = now()
    const startedBytes = request.socket.bytesWritten
    const requestId = newRequestId()
    response.setHeader("x-request-id", requestId)
    response.once("finish", () => {
      const timestamp = now()
      const status = response.statusCode
      const event: RequestTelemetry = {
        timestamp,
        level: status >= 500 ? "error" : "info",
        event: "http.request",
        requestId,
        method: request.method ?? "UNKNOWN",
        routeTemplate: classifyRoute(request),
        status,
        durationMs: Math.max(0, Date.parse(timestamp) - Date.parse(startedAt)),
        bytes: Math.max(0, request.socket.bytesWritten - startedBytes),
        errorCode: responseErrors.get(response) ?? defaultErrorCode(status),
      }
      try {
        sink(event)
      } catch {
        process.stderr.write("request telemetry sink failed\n")
      }
    })
    next(request, response)
  }
}

function classifyRoute(request: IncomingMessage): string {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname
  if (request.method === "GET" && pathname === "/health") return "/health"
  for (const route of COMMAND_ROUTES) {
    if (route.method === request.method && route.pattern.test(pathname)) {
      return commandTemplate(route.pattern)
    }
  }
  for (const [pattern, template] of STATIC_ROUTES) {
    if (pattern.test(pathname)) return template
  }
  if (pathname === "/" || pathname === "/index.html") return "/"
  if (/^\/assets\//.test(pathname)) return "/assets/*"
  return "unmatched"
}

function commandTemplate(pattern: RegExp): string {
  let capture = 0
  return pattern.source
    .replace(/^\^|\$$/g, "")
    .replaceAll("\\/", "/")
    .replaceAll("([^/]+)", () => (capture++ === 0 ? ":workspaceId" : ":resourceId"))
}

function defaultErrorCode(status: number): string | null {
  if (status < 400) return null
  if (status === 400) return "invalid_argument"
  if (status === 401) return "unauthenticated"
  if (status === 403) return "permission_denied"
  if (status === 404) return "not_found"
  if (status >= 500) return "internal"
  return "request_failed"
}

const STATIC_ROUTES: readonly (readonly [RegExp, string])[] = [
  [
    /^\/api\/events\/v1\/workspaces\/[^/]+\/events$/,
    "/api/events/v1/workspaces/:workspaceId/events",
  ],
  [/^\/api\/workspaces\/[^/]+\/events$/, "/api/workspaces/:workspaceId/events"],
  [/^\/api\/workspaces\/[^/]+\/work-items$/, "/api/workspaces/:workspaceId/work-items"],
  [/^\/api\/work-items\/[^/]+$/, "/api/work-items/:workItemId"],
  [
    /^\/api\/human\/v1\/workspaces\/[^/]+\/bootstrap$/,
    "/api/human/v1/workspaces/:workspaceId/bootstrap",
  ],
  [/^\/api\/human\/v1\/workspaces\/[^/]+\/spaces$/, "/api/human/v1/workspaces/:workspaceId/spaces"],
  [
    /^\/api\/human\/v1\/workspaces\/[^/]+\/spaces\/[^/]+\/config$/,
    "/api/human/v1/workspaces/:workspaceId/spaces/:spaceId/config",
  ],
  [
    /^\/api\/human\/v1\/workspaces\/[^/]+\/projects\/[^/]+$/,
    "/api/human/v1/workspaces/:workspaceId/projects/:projectId",
  ],
  [
    /^\/api\/human\/v1\/workspaces\/[^/]+\/work-items\/[^/]+$/,
    "/api/human/v1/workspaces/:workspaceId/work-items/:workItemId",
  ],
  [
    /^\/api\/human\/v1\/workspaces\/[^/]+\/entities\/[^/]+\/(history|relations|comments)$/,
    "/api/human/v1/workspaces/:workspaceId/entities/:entityId/:collection",
  ],
  [
    /^\/api\/human\/v1\/workspaces\/[^/]+\/(work-items\/query|projects\/query|work-items\/board|search|export|saved-views)$/,
    "/api/human/v1/workspaces/:workspaceId/:operation",
  ],
  [
    /^\/api\/commands\/v1\/workspaces\/[^/]+\/imports$/,
    "/api/commands/v1/workspaces/:workspaceId/imports",
  ],
]
