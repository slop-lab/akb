import type { Sql } from "postgres"
import { z } from "zod"
import { EntityNotFoundError } from "../../entities/errors.ts"
import { CreateProjectNotebookSchema } from "../../project-kb/contracts.ts"
import { ProjectNotebookService } from "../../project-kb/notebook-service.ts"
import {
  createFeatureCommandRouter,
  type FeatureCommandCall,
  type FeatureCommandExecutor,
  featureCommandRoute,
} from "../feature-command-router.ts"
import { invalidArgument, writeJson } from "../responses.ts"
import type { WorkspaceAuthenticatedRoute } from "../route-types.ts"

const NOTEBOOK_PATTERN = /^\/api\/project-kb\/v1\/workspaces\/([^/]+)\/projects\/([^/]+)\/notebook$/
const NOTEBOOK_ACTION = "project-notebook.create" as const

export function createProjectKbRoutes(sql: Sql): readonly WorkspaceAuthenticatedRoute[] {
  const notebooks = new ProjectNotebookService(sql)
  return [createNotebookReadRoute(notebooks), createNotebookCommandRoute(sql, notebooks)]
}

function createNotebookCommandRoute(
  sql: Sql,
  notebooks: ProjectNotebookService,
): WorkspaceAuthenticatedRoute {
  const executor: FeatureCommandExecutor<typeof NOTEBOOK_ACTION> = {
    execute: (call) =>
      notebooks.create(
        call,
        requiredProjectId(call),
        CreateProjectNotebookSchema.parse(call.payload),
      ),
  }
  return createFeatureCommandRouter(
    sql,
    [
      featureCommandRoute({
        method: "POST",
        pattern: NOTEBOOK_PATTERN,
        action: NOTEBOOK_ACTION,
        payload: CreateProjectNotebookSchema,
        create: true,
        parentCapture: 2,
      }),
    ],
    executor,
  )
}

function createNotebookReadRoute(notebooks: ProjectNotebookService): WorkspaceAuthenticatedRoute {
  return async (request, response, principal) => {
    if (request.method !== "GET") return false
    const matched = NOTEBOOK_PATTERN.exec(new URL(request.url ?? "/", "http://localhost").pathname)
    if (matched === null) return false
    try {
      const workspaceId = decode(matched[1])
      const projectId = decode(matched[2])
      writeJson(response, 200, await notebooks.get(principal, workspaceId, projectId))
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        writeJson(response, 404, {
          error: {
            code: "not_found",
            message: "entity was not found",
            retryable: false,
            details: {},
          },
        })
      } else if (error instanceof URIError || error instanceof z.ZodError) {
        invalidArgument(response, [{ field: "path", message: error.message }])
      } else {
        throw error
      }
    }
    return true
  }
}

function requiredProjectId(call: FeatureCommandCall<typeof NOTEBOOK_ACTION>): string {
  if (call.parentId === null) throw new URIError("project path segment is missing")
  return call.parentId
}

function decode(value: string | undefined): string {
  if (value === undefined) throw new URIError("path segment is missing")
  const decoded = decodeURIComponent(value)
  if (decoded.trim().length === 0 || decoded.includes("/") || decoded.includes("\\")) {
    throw new URIError("path segment is invalid")
  }
  return decoded
}
