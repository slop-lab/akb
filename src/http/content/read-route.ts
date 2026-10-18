import type { ServerResponse } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import { ContentInvariantError } from "../../content/errors.ts"
import { ContentReadService } from "../../content/read-service.ts"
import { UpdatePresenceSchema } from "../../contracts/content/requests.ts"
import type { PageProjectionProvider } from "../../contracts/content/routes.ts"
import { EntityNotFoundError } from "../../entities/errors.ts"
import { RequestBodyError, readJson } from "../human-v1/body.ts"
import { writeJson } from "../responses.ts"
import type { WorkspaceAuthenticatedRoute } from "../route-types.ts"

export function createContentReadRoute(
  sql: Sql,
  projectionProvider?: PageProjectionProvider,
): WorkspaceAuthenticatedRoute {
  const reads = new ContentReadService(sql)
  return async (request, response, principal) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    const matched = /^\/api\/content\/v1\/workspaces\/([^/]+)(\/.*)$/.exec(url.pathname)
    if (matched === null) return false
    try {
      const workspaceId = segment(matched[1])
      const path = matched[2] ?? "/"
      if (workspaceId !== principal.workspaceId) throw new EntityNotFoundError(workspaceId)
      if (request.method === "GET" && path === "/pages") {
        const parent = url.searchParams.get("parentPageId")
        writeJson(response, 200, { pages: await reads.children(principal, parent) })
        return true
      }
      const route = /^\/pages\/([^/]+)(\/.*)?$/.exec(path)
      if (route === null) return false
      const pageId = segment(route[1])
      const suffix = route[2] ?? ""
      if (request.method === "GET" && suffix === "") {
        const page = await reads.page(principal, pageId)
        const projection =
          projectionProvider === undefined ? {} : await projectionProvider.project(page)
        writeJson(response, 200, { page, projection })
        return true
      }
      if (request.method === "GET" && suffix === "/history") {
        writeJson(response, 200, { revisions: await reads.history(principal, pageId) })
        return true
      }
      if (request.method === "GET" && suffix === "/comments") {
        writeJson(response, 200, { comments: await reads.comments(principal, pageId) })
        return true
      }
      if (request.method === "GET" && suffix === "/backlinks") {
        writeJson(response, 200, { backlinks: await reads.backlinks(principal, pageId) })
        return true
      }
      if (request.method === "GET" && suffix === "/presence") {
        writeJson(response, 200, { presence: await reads.presence(principal, pageId) })
        return true
      }
      if (request.method === "PUT" && suffix === "/presence") {
        const body = UpdatePresenceSchema.parse(await readJson(request))
        await reads.updatePresence(principal, pageId, body.blockId, body.cursor)
        response.writeHead(204)
        response.end()
        return true
      }
      if (request.method === "GET" && suffix === "/export") {
        writeMarkdown(response, await reads.markdown(principal, pageId))
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
        writeError(response, 400, "invalid_argument")
        return true
      }
      if (error instanceof EntityNotFoundError) {
        writeError(response, 404, "not_found")
        return true
      }
      if (error instanceof ContentInvariantError) {
        writeError(response, 409, error.code)
        return true
      }
      throw error
    }
  }
}

function segment(value: string | undefined): string {
  if (value === undefined) throw new URIError("missing path segment")
  const decoded = decodeURIComponent(value)
  if (decoded.length === 0 || decoded.includes("/") || decoded.includes("\\")) {
    throw new URIError("invalid path segment")
  }
  return decoded
}

function writeMarkdown(response: ServerResponse, markdown: string): void {
  response.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-length": Buffer.byteLength(markdown),
  })
  response.end(markdown)
}

function writeError(response: ServerResponse, status: number, code: string): void {
  writeJson(response, status, {
    error: { code, message: code, retryable: false, details: {} },
  })
}
