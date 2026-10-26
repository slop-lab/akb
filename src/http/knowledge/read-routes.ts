import type { IncomingMessage } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import { KnowledgeProposalStatusSchema } from "../../contracts/knowledge/index.ts"
import { EntityNotFoundError } from "../../entities/errors.ts"
import { WorkspaceNotFoundError } from "../../identity/authorization-errors.ts"
import { KnowledgeProposalReader } from "../../knowledge/proposal-reader.ts"
import { KnowledgeReader } from "../../knowledge/reader.ts"
import { invalidArgument, writeJson } from "../responses.ts"
import type { WorkspaceAuthenticatedRoute } from "../route-types.ts"

const SearchQuerySchema = z.strictObject({
  query: z.string().max(500).default(""),
  includeSuperseded: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
const ProposalQuerySchema = z.strictObject({
  status: KnowledgeProposalStatusSchema.default("pending"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
const RevisionSchema = z.coerce.number().int().positive()

export function createKnowledgeReadRoute(sql: Sql): WorkspaceAuthenticatedRoute {
  return async (request, response, principal) => {
    const matched = match(request)
    if (matched === undefined) return false
    try {
      const reader = new KnowledgeReader(sql, principal)
      const proposalReader = new KnowledgeProposalReader(sql, principal)
      const workspaceId = decode(matched.workspaceId)
      switch (matched.kind) {
        case "get": {
          const object = await reader.get(workspaceId, decode(matched.knowledgeId))
          if (object === undefined) throw new EntityNotFoundError(matched.knowledgeId)
          writeJson(response, 200, object)
          break
        }
        case "get_revision": {
          const object = await reader.getRevision(
            workspaceId,
            decode(matched.knowledgeId),
            RevisionSchema.parse(decode(matched.revision)),
          )
          if (object === undefined) throw new EntityNotFoundError(matched.knowledgeId)
          writeJson(response, 200, object)
          break
        }
        case "history":
          writeJson(response, 200, await reader.history(workspaceId, decode(matched.knowledgeId)))
          break
        case "summaries":
          writeJson(response, 200, await reader.summaries(workspaceId, decode(matched.knowledgeId)))
          break
        case "search": {
          const url = new URL(request.url ?? "/", "http://localhost")
          const query = SearchQuerySchema.parse(Object.fromEntries(url.searchParams))
          writeJson(
            response,
            200,
            await reader.search(workspaceId, query.query, query.includeSuperseded, query.limit),
          )
          break
        }
        case "proposal_get": {
          const proposal = await proposalReader.get(workspaceId, decode(matched.proposalId))
          if (proposal === undefined) throw new EntityNotFoundError(matched.proposalId)
          writeJson(response, 200, { proposal })
          break
        }
        case "proposal_list": {
          const url = new URL(request.url ?? "/", "http://localhost")
          const query = ProposalQuerySchema.parse(Object.fromEntries(url.searchParams))
          writeJson(response, 200, {
            proposals: await proposalReader.list(workspaceId, query.status, query.limit),
          })
          break
        }
        default:
          assertNever(matched)
      }
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof URIError) {
        invalidArgument(response, [{ field: "request", message: "request is invalid" }])
      } else if (error instanceof EntityNotFoundError || error instanceof WorkspaceNotFoundError) {
        writeJson(response, 404, {
          error: { code: "not_found", message: "not found", retryable: false, details: {} },
        })
      } else {
        throw error
      }
    }
    return true
  }
}

type ReadMatch =
  | { readonly kind: "get"; readonly workspaceId: string; readonly knowledgeId: string }
  | {
      readonly kind: "get_revision"
      readonly workspaceId: string
      readonly knowledgeId: string
      readonly revision: string
    }
  | { readonly kind: "history"; readonly workspaceId: string; readonly knowledgeId: string }
  | { readonly kind: "summaries"; readonly workspaceId: string; readonly knowledgeId: string }
  | { readonly kind: "search"; readonly workspaceId: string }
  | { readonly kind: "proposal_get"; readonly workspaceId: string; readonly proposalId: string }
  | { readonly kind: "proposal_list"; readonly workspaceId: string }

function match(request: IncomingMessage): ReadMatch | undefined {
  if (request.method !== "GET") return undefined
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname
  const proposal = /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/proposals\/([^/]+)$/.exec(pathname)
  if (proposal !== null) {
    return {
      kind: "proposal_get",
      workspaceId: required(proposal[1]),
      proposalId: required(proposal[2]),
    }
  }
  const proposals = /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/proposals$/.exec(pathname)
  if (proposals !== null) {
    return { kind: "proposal_list", workspaceId: required(proposals[1]) }
  }
  const history = /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/objects\/([^/]+)\/history$/.exec(
    pathname,
  )
  if (history !== null)
    return { kind: "history", workspaceId: required(history[1]), knowledgeId: required(history[2]) }
  const summaries = /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/objects\/([^/]+)\/summaries$/.exec(
    pathname,
  )
  if (summaries !== null)
    return {
      kind: "summaries",
      workspaceId: required(summaries[1]),
      knowledgeId: required(summaries[2]),
    }
  const revision =
    /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/objects\/([^/]+)\/revisions\/([^/]+)$/.exec(
      pathname,
    )
  if (revision !== null) {
    return {
      kind: "get_revision",
      workspaceId: required(revision[1]),
      knowledgeId: required(revision[2]),
      revision: required(revision[3]),
    }
  }
  const object = /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/objects\/([^/]+)$/.exec(pathname)
  if (object !== null)
    return { kind: "get", workspaceId: required(object[1]), knowledgeId: required(object[2]) }
  const search = /^\/api\/knowledge\/v1\/workspaces\/([^/]+)\/objects$/.exec(pathname)
  return search === null ? undefined : { kind: "search", workspaceId: required(search[1]) }
}

function decode(value: string): string {
  const decoded = decodeURIComponent(value)
  if (decoded.trim().length === 0 || decoded.includes("/") || decoded.includes("\\"))
    throw new URIError("invalid path")
  return decoded
}
function required(value: string | undefined): string {
  if (value === undefined) throw new URIError("path capture missing")
  return value
}
function assertNever(value: never): never {
  throw new TypeError(`unsupported knowledge read: ${JSON.stringify(value)}`)
}
