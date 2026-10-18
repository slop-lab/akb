import type { Sql } from "postgres"
import { z } from "zod"
import { AutomationAnalytics } from "../../automation/analytics.ts"
import { type IntakeAction, IntakeService } from "../../automation/intake-service.ts"
import {
  AutomationRegistryService,
  type RegistryAction,
} from "../../automation/registry-service.ts"
import {
  AutomationCreateSchema,
  ExtensionApprovalSchema,
  ExtensionManifestSchema,
  GitHubInstallationSchema,
  GitHubMappingSchema,
  IntakeAcceptSchema,
  IntakeCreateSchema,
  IntakeDispositionSchema,
  RecurrenceCreateSchema,
} from "../../contracts/automation/index.ts"
import { CommandEnvelopeSchema } from "../../contracts/r4/command.ts"
import { EntityNotFoundError } from "../../entities/errors.ts"
import { createFeatureCommandRouter, featureCommandRoute } from "../feature-command-router.ts"
import { RequestBodyError, readJson } from "../human-v1/body.ts"
import { invalidArgument, writeJson } from "../responses.ts"
import type { WorkspaceAuthenticatedRoute } from "../route-types.ts"

export function createAutomationRoutes(sql: Sql): readonly WorkspaceAuthenticatedRoute[] {
  const registry = new AutomationRegistryService(sql)
  return [
    createReadAndDirectRoute(sql, registry),
    createFeatureCommandRouter(sql, INTAKE_ROUTES, new IntakeService(sql)),
    createFeatureCommandRouter(sql, REGISTRY_ROUTES, registry),
  ]
}

export { createGitHubWebhookRoute, type RawWebhookRoute } from "./github-webhook.ts"

const BASE = "^/api/automation/v1/workspaces/([^/]+)"
const INTAKE_ROUTES = [
  route("POST", `${BASE}/intake$`, "intake.create", IntakeCreateSchema, true),
  route("POST", `${BASE}/intake/([^/]+)/accept$`, "intake.accept", IntakeAcceptSchema, false, 2),
  route(
    "PATCH",
    `${BASE}/intake/([^/]+)/disposition$`,
    "intake.disposition",
    IntakeDispositionSchema,
    false,
    2,
  ),
] as const
const REGISTRY_ROUTES = [
  route("POST", `${BASE}/recurrences$`, "recurrence.create", RecurrenceCreateSchema, true),
  route("POST", `${BASE}/rules$`, "automation.create", AutomationCreateSchema, true),
  route("POST", `${BASE}/github/installations$`, "github.install", GitHubInstallationSchema, true),
  route(
    "POST",
    `${BASE}/extensions/approvals$`,
    "extension.approve",
    ExtensionApprovalSchema,
    true,
  ),
] as const

function createReadAndDirectRoute(
  sql: Sql,
  registry: AutomationRegistryService,
): WorkspaceAuthenticatedRoute {
  const analytics = new AutomationAnalytics(sql)
  return async (request, response, principal) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const root = new RegExp(`${BASE}(/.*)$`).exec(url.pathname)
    if (root === null) return false
    try {
      if (decode(root[1]) !== principal.workspaceId)
        throw new EntityNotFoundError(principal.workspaceId)
      const path = root[2] ?? "/"
      if (request.method === "GET" && path === "/analytics") {
        writeJson(
          response,
          200,
          await analytics.query(principal, Object.fromEntries(url.searchParams)),
        )
        return true
      }
      if (request.method === "POST" && path === "/extensions/manifests") {
        const call = await directCall(
          request,
          principal,
          "extension.submit",
          ExtensionManifestSchema,
        )
        writeJson(response, 201, await registry.submitManifest(call))
        return true
      }
      if (request.method === "POST" && path === "/github/mappings") {
        const call = await directCall(request, principal, "github.map", GitHubMappingSchema)
        writeJson(response, 201, await registry.mapGitHub(call))
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
        writeJson(response, 404, {
          error: { code: "not_found", message: "not_found", retryable: false, details: {} },
        })
        return true
      }
      throw error
    }
  }
}

async function directCall<Action extends RegistryAction>(
  request: Parameters<WorkspaceAuthenticatedRoute>[0],
  principal: Parameters<WorkspaceAuthenticatedRoute>[2],
  action: Action,
  schema: z.ZodType,
) {
  const envelope = CommandEnvelopeSchema.parse(await readJson(request, 256 * 1024))
  return {
    workspaceId: principal.workspaceId,
    principal,
    commandId: envelope.commandId,
    idempotencyKey: envelope.idempotencyKey,
    baseRevision: envelope.baseRevision,
    action,
    route: request.url ?? "",
    resourceId: null,
    parentId: null,
    payload: schema.parse(envelope.payload),
  }
}
function route<Action extends IntakeAction | RegistryAction>(
  method: "POST" | "PATCH",
  pattern: string,
  action: Action,
  payload: z.ZodType,
  create: boolean,
  resourceCapture?: number,
) {
  return featureCommandRoute({
    method,
    pattern: new RegExp(pattern),
    action,
    payload,
    create,
    ...(resourceCapture === undefined ? {} : { resourceCapture }),
  })
}
function decode(value: string | undefined): string {
  if (value === undefined) throw new URIError("path segment missing")
  return decodeURIComponent(value)
}
