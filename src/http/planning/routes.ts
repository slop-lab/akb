import type { Sql } from "postgres"
import { z } from "zod"
import {
  CycleCreateSchema,
  CycleRolloverSchema,
  CycleUpdateSchema,
  InboxQuerySchema,
  MilestoneCreateSchema,
  MilestoneUpdateSchema,
  ModuleCreateSchema,
  ModuleUpdateSchema,
  NotificationPreferencesUpdateSchema,
  NotificationReadSchema,
  ProjectUpdateCreateSchema,
  TemplateApplySchema,
  TemplateCreateSchema,
  TemplateRevisionCreateSchema,
  WorkPlanningSchema,
} from "../../contracts/planning/index.ts"
import { EntityNotFoundError } from "../../entities/errors.ts"
import { PlanningCommandService } from "../../planning/command-service.ts"
import { PlanningQueries } from "../../planning/queries.ts"
import type { PlanningAction } from "../../planning/types.ts"
import { createFeatureCommandRouter, featureCommandRoute } from "../feature-command-router.ts"
import { invalidArgument, writeJson } from "../responses.ts"
import type { WorkspaceAuthenticatedRoute } from "../route-types.ts"

const BASE = "^/api/planning/v1/workspaces/([^/]+)"
const EmptySchema = z.strictObject({})

const COMMAND_ROUTES = [
  command("POST", `${BASE}/spaces/([^/]+)/cycles$`, "cycle.create", CycleCreateSchema, true, 2),
  command(
    "PATCH",
    `${BASE}/cycles/([^/]+)$`,
    "cycle.update",
    CycleUpdateSchema,
    false,
    undefined,
    2,
  ),
  command(
    "POST",
    `${BASE}/cycles/([^/]+)/activate$`,
    "cycle.activate",
    EmptySchema,
    false,
    undefined,
    2,
  ),
  command(
    "POST",
    `${BASE}/cycles/([^/]+)/rollover$`,
    "cycle.rollover",
    CycleRolloverSchema,
    false,
    undefined,
    2,
  ),
  command(
    "POST",
    `${BASE}/projects/([^/]+)/milestones$`,
    "milestone.create",
    MilestoneCreateSchema,
    true,
    2,
  ),
  command(
    "PATCH",
    `${BASE}/milestones/([^/]+)$`,
    "milestone.update",
    MilestoneUpdateSchema,
    false,
    undefined,
    2,
  ),
  command(
    "POST",
    `${BASE}/projects/([^/]+)/modules$`,
    "module.create",
    ModuleCreateSchema,
    true,
    2,
  ),
  command(
    "PATCH",
    `${BASE}/modules/([^/]+)$`,
    "module.update",
    ModuleUpdateSchema,
    false,
    undefined,
    2,
  ),
  command(
    "PUT",
    `${BASE}/work-items/([^/]+)/planning$`,
    "work-planning.update",
    WorkPlanningSchema,
    false,
    undefined,
    2,
  ),
  command(
    "POST",
    `${BASE}/projects/([^/]+)/updates$`,
    "project-update.publish",
    ProjectUpdateCreateSchema,
    true,
    2,
  ),
  command("POST", `${BASE}/templates$`, "template.create", TemplateCreateSchema, true),
  command(
    "POST",
    `${BASE}/templates/([^/]+)/revisions$`,
    "template.revise",
    TemplateRevisionCreateSchema,
    false,
    undefined,
    2,
  ),
  command(
    "POST",
    `${BASE}/templates/([^/]+)/apply$`,
    "template.apply",
    TemplateApplySchema,
    true,
    2,
  ),
  command(
    "POST",
    `${BASE}/notification-preferences$`,
    "notification-preferences.create",
    NotificationPreferencesUpdateSchema,
    true,
  ),
  command(
    "PATCH",
    `${BASE}/notification-preferences/([^/]+)$`,
    "notification-preferences.update",
    NotificationPreferencesUpdateSchema,
    false,
    undefined,
    2,
  ),
  command(
    "PATCH",
    `${BASE}/notification-preferences/([^/]+)/inbox/read$`,
    "notification.read",
    NotificationReadSchema,
    false,
    undefined,
    2,
  ),
] as const

export function createPlanningRoutes(sql: Sql): readonly WorkspaceAuthenticatedRoute[] {
  return [
    createPlanningQueryRoute(sql),
    createFeatureCommandRouter(sql, COMMAND_ROUTES, new PlanningCommandService(sql)),
  ]
}

function createPlanningQueryRoute(sql: Sql): WorkspaceAuthenticatedRoute {
  const queries = new PlanningQueries(sql)
  return async (request, response, principal) => {
    if (request.method !== "GET") return false
    const url = new URL(request.url ?? "/", "http://localhost")
    const root = new RegExp(`${BASE}(/.*)$`).exec(url.pathname)
    if (root === null) return false
    try {
      if (decode(root[1]) !== principal.workspaceId)
        throw new EntityNotFoundError(principal.workspaceId)
      const path = root[2] ?? "/"
      const cycle = /^\/spaces\/([^/]+)\/cycles$/.exec(path)
      if (cycle !== null)
        return write(response, { cycles: await queries.cycles(principal, decode(cycle[1])) })
      const milestones = /^\/projects\/([^/]+)\/milestones$/.exec(path)
      if (milestones !== null)
        return write(response, {
          milestones: await queries.milestones(principal, decode(milestones[1])),
        })
      const modules = /^\/projects\/([^/]+)\/modules$/.exec(path)
      if (modules !== null)
        return write(response, { modules: await queries.modules(principal, decode(modules[1])) })
      const progress = /^\/projects\/([^/]+)\/progress$/.exec(path)
      if (progress !== null)
        return write(response, await queries.progress(principal, decode(progress[1])))
      const timeline = /^\/projects\/([^/]+)\/timeline$/.exec(path)
      if (timeline !== null)
        return write(response, { entries: await queries.timeline(principal, decode(timeline[1])) })
      const updates = /^\/projects\/([^/]+)\/updates$/.exec(path)
      if (updates !== null)
        return write(response, { updates: await queries.updates(principal, decode(updates[1])) })
      if (path === "/templates")
        return write(response, { templates: await queries.templates(principal) })
      if (path === "/notification-preferences")
        return write(response, await queries.preferences(principal))
      if (path === "/inbox") {
        const parsed = InboxQuerySchema.parse(Object.fromEntries(url.searchParams))
        return write(response, await queries.inbox(principal, parsed.after, parsed.limit))
      }
      writeJson(response, 404, error("not_found"))
    } catch (caught) {
      if (caught instanceof z.ZodError || caught instanceof URIError)
        invalidArgument(response, [{ field: "request", message: "request is invalid" }])
      else if (caught instanceof EntityNotFoundError) writeJson(response, 404, error("not_found"))
      else throw caught
    }
    return true
  }
}

function command(
  method: "POST" | "PATCH" | "PUT",
  pattern: string,
  action: PlanningAction,
  payload: z.ZodType,
  create: boolean,
  parentCapture?: number,
  resourceCapture?: number,
) {
  return featureCommandRoute({
    method,
    pattern: new RegExp(pattern),
    action,
    payload,
    create,
    ...(parentCapture === undefined ? {} : { parentCapture }),
    ...(resourceCapture === undefined ? {} : { resourceCapture }),
  })
}
function decode(value: string | undefined): string {
  if (value === undefined) throw new URIError("path segment missing")
  const decoded = decodeURIComponent(value)
  if (decoded.trim().length === 0 || decoded.includes("/") || decoded.includes("\\"))
    throw new URIError("path segment invalid")
  return decoded
}
function write(response: Parameters<WorkspaceAuthenticatedRoute>[1], body: unknown): true {
  writeJson(response, 200, body)
  return true
}
function error(code: string) {
  return { error: { code, message: code, retryable: false, details: {} } }
}
