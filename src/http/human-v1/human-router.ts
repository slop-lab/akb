import type { IncomingMessage, ServerResponse } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import {
  BoardRequestSchema,
  HumanWorkQuerySchema,
  ProjectQuerySchema,
  SearchRequestSchema,
} from "../../contracts/r4/index.ts"
import { BoardService } from "../../human-query/board-service.ts"
import { ProjectQueryService } from "../../human-query/project-query-service.ts"
import { HumanReadService } from "../../human-query/read-service.ts"
import {
  HumanQueryService,
  QueryBudgetExceededError,
  SnapshotConflictError,
} from "../../human-query/service.ts"
import type { AuthenticatedPrincipal } from "../../identity/types.ts"
import { exportAuthorizedProject } from "../../import-export/export-service.ts"
import { searchAuthorized } from "../../search/postgres-search.ts"
import { markResponseError } from "../request-telemetry.ts"
import { RequestBodyError, readJson } from "./body.ts"

export type AuthenticatedRoute = (
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthenticatedPrincipal,
) => Promise<boolean>

export function createR4HumanRouter(sql: Sql, signingKey: Uint8Array): AuthenticatedRoute {
  const queryService = new HumanQueryService(sql, signingKey)
  const boardService = new BoardService(sql, signingKey)
  const projectQueryService = new ProjectQueryService(sql, signingKey)
  const reads = new HumanReadService(sql)
  return async (request, response, principal) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const match = /^\/api\/human\/v1\/workspaces\/([^/]+)(\/.*)$/.exec(url.pathname)
    if (match === null) return false
    let workspaceId: string
    let path: string
    try {
      workspaceId = decodeURIComponent(match[1] ?? "")
      path = match[2] ?? "/"
    } catch {
      writeError(response, 400, "invalid_argument")
      return true
    }
    if (workspaceId !== principal.workspaceId) {
      writeError(response, 404, "not_found")
      return true
    }
    try {
      return await routeMatched(
        request,
        response,
        principal,
        workspaceId,
        path,
        queryService,
        boardService,
        projectQueryService,
        reads,
        sql,
      )
    } catch (error) {
      if (
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof RequestBodyError
      ) {
        writeError(response, 400, "invalid_argument")
        return true
      }
      if (error instanceof SnapshotConflictError) {
        writeError(response, error.code === "snapshot_expired" ? 410 : 409, error.code)
        return true
      }
      if (error instanceof QueryBudgetExceededError) {
        writeError(response, 507, "query_budget_exceeded")
        return true
      }
      throw error
    }
  }
}

async function routeMatched(
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthenticatedPrincipal,
  workspaceId: string,
  path: string,
  queries: HumanQueryService,
  boards: BoardService,
  projectQueries: ProjectQueryService,
  reads: HumanReadService,
  sql: Sql,
): Promise<true> {
  if (request.method === "GET" && path === "/bootstrap")
    return write(response, await reads.bootstrap(principal))
  if (request.method === "GET" && path === "/spaces")
    return write(response, { spaces: await reads.spaces(principal) })
  if (request.method === "GET" && path === "/saved-views")
    return write(response, { views: await reads.savedViews(principal) })
  const config = /^\/spaces\/([^/]+)\/config$/.exec(path)
  if (request.method === "GET" && config !== null)
    return writeFound(response, await reads.spaceConfig(principal, segment(config[1])))
  const project = /^\/projects\/([^/]+)$/.exec(path)
  if (request.method === "GET" && project !== null)
    return writeFound(response, await reads.project(principal, segment(project[1])))
  const item = /^\/work-items\/([^/]+)$/.exec(path)
  if (request.method === "GET" && item !== null)
    return writeFound(response, await queries.getWorkItem(principal, workspaceId, segment(item[1])))
  const history = /^\/entities\/([^/]+)\/history$/.exec(path)
  if (request.method === "GET" && history !== null)
    return writeFound(response, await reads.history(principal, segment(history[1])))
  const relations = /^\/entities\/([^/]+)\/relations$/.exec(path)
  if (request.method === "GET" && relations !== null)
    return writeFound(response, await reads.relations(principal, segment(relations[1])))
  const comments = /^\/entities\/([^/]+)\/comments$/.exec(path)
  if (request.method === "GET" && comments !== null)
    return writeFound(response, await reads.comments(principal, segment(comments[1])))
  const snapshot = /^\/query-snapshots\/([^/]+)$/.exec(path)
  if (request.method === "DELETE" && snapshot !== null) {
    const snapshotId = z.string().uuid().parse(segment(snapshot[1]))
    await reads.releaseSnapshot(principal, workspaceId, snapshotId)
    response.writeHead(204)
    response.end()
    return true
  }
  if (request.method === "POST" && path === "/work-items/query") {
    const body = HumanWorkQuerySchema.parse(await readJson(request))
    return write(response, await queries.queryWorkItems(principal, workspaceId, body))
  }
  if (request.method === "POST" && path === "/projects/query") {
    const body = ProjectQuerySchema.parse(await readJson(request))
    return write(response, await projectQueries.queryProjects(principal, workspaceId, body))
  }
  if (request.method === "POST" && path === "/work-items/board") {
    const body = BoardRequestSchema.parse(await readJson(request))
    return write(response, await boards.query(principal, workspaceId, body))
  }
  if (request.method === "POST" && path === "/search") {
    const body = SearchRequestSchema.parse(await readJson(request))
    return write(response, { results: await searchAuthorized(sql, principal, body) })
  }
  if (request.method === "POST" && path === "/export") {
    await readJson(request)
    const output = await exportAuthorizedProject(sql, principal)
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-length": Buffer.byteLength(output),
    })
    response.end(output)
    return true
  }
  writeError(response, 404, "not_found")
  return true
}

function segment(value: string | undefined): string {
  if (value === undefined) throw new RequestBodyError("missing path segment")
  return decodeURIComponent(value)
}

function write(response: ServerResponse, body: unknown): true {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(body))
  return true
}

function writeFound(response: ServerResponse, body: unknown | undefined): true {
  if (body === undefined) return writeError(response, 404, "not_found")
  return write(response, body)
}

function writeError(response: ServerResponse, status: number, code: string): true {
  markResponseError(response, code)
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify({ error: { code, message: code, retryable: false, details: {} } }))
  return true
}
