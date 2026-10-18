import type { IncomingMessage, ServerResponse } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import {
  ActivityInputSchema,
  ArtifactChunkInputSchema,
  DeltaRequestSchema,
  GenerationInputSchema,
  PlanStepInputSchema,
  RetrievalRequestSchema,
} from "../../contracts/runtime/index.ts"
import { RetrievalService } from "../../retrieval/service.ts"
import {
  RunNotActiveError,
  RuntimeAuthenticationError,
  RuntimeConflictError,
} from "../../runtime/errors.ts"
import { authenticateRunToken } from "../../runtime/principal.ts"
import { RuntimeWrites } from "../../runtime/writes.ts"
import { RequestBodyError, readJson } from "../human-v1/body.ts"
import { writeJson } from "../responses.ts"

const BootstrapRowSchema = z.strictObject({ subject_ref: z.string(), directive_ref: z.string() })

export type RuntimeRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>

export function createRuntimeRequestHandler(
  sql: Sql,
  signingKey: Uint8Array,
): RuntimeRequestHandler {
  const retrieval = new RetrievalService(sql, signingKey)
  const writes = new RuntimeWrites(sql)
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (!url.pathname.startsWith("/api/runtime/v1/")) return false
    const match = /^\/api\/runtime\/v1\/runs\/([^/]+)(\/.*)$/.exec(url.pathname)
    if (match === null) return false
    try {
      const token = bearerToken(request)
      if (token === undefined) throw new RuntimeAuthenticationError()
      const principal = await sql.begin((transaction) => authenticateRunToken(transaction, token))
      if (principal === undefined || principal.runId !== segment(match[1])) {
        throw new RuntimeAuthenticationError()
      }
      const path = match[2] ?? "/"
      if (request.method === "POST" && path === "/lease/ack") {
        const input = GenerationInputSchema.parse(await readJson(request, 4096))
        await writes.acknowledge(principal, input.generation)
        return written(response, 200, { state: "running", generation: input.generation })
      }
      if (request.method === "POST" && path === "/heartbeat") {
        const input = GenerationInputSchema.parse(await readJson(request, 4096))
        await writes.heartbeat(principal, input.generation)
        return written(response, 200, { accepted: true })
      }
      if (request.method === "GET" && path === "/bootstrap") {
        const rows =
          await sql`select subject_ref,directive_ref from runtime_runs where id=${principal.runId}`
        if (rows[0] === undefined) throw new RunNotActiveError()
        const run = BootstrapRowSchema.parse(rows[0])
        const context = await retrieval.retrieve(
          principal,
          RetrievalRequestSchema.parse({
            operation: "read_entities",
            ids: [run.subject_ref],
            kinds: ["work_item", "project", "page", "knowledge_object"],
            projection: "card",
            budget: { maxItems: 20, maxTokens: 4000 },
            cursor: null,
          }),
        )
        return written(response, 200, {
          objective: run.directive_ref,
          subjectRef: run.subject_ref,
          constraints: [],
          context,
        })
      }
      if (request.method === "POST" && path === "/retrieval") {
        const input = RetrievalRequestSchema.parse(await readJson(request, 64 * 1024))
        return written(response, 200, await retrieval.retrieve(principal, input))
      }
      if (request.method === "POST" && path === "/retrieval/delta") {
        const input = DeltaRequestSchema.parse(await readJson(request, 64 * 1024))
        return written(response, 200, await retrieval.delta(principal, input))
      }
      if (request.method === "POST" && path === "/activity") {
        const input = ActivityInputSchema.parse(await readJson(request, 128 * 1024))
        return written(response, 201, await writes.activity(principal, input))
      }
      if (request.method === "PUT" && path === "/plan") {
        const input = PlanStepInputSchema.parse(await readJson(request, 128 * 1024))
        return written(response, 200, await writes.plan(principal, input))
      }
      if (request.method === "POST" && path === "/artifacts/chunks") {
        const input = ArtifactChunkInputSchema.parse(await readJson(request, 400 * 1024))
        return written(response, 201, await writes.artifact(principal, input))
      }
      writeRuntimeError(response, 404, "not_found")
      return true
    } catch (error) {
      handleRuntimeError(response, error)
      return true
    }
  }
}

function bearerToken(request: IncomingMessage): string | undefined {
  const values = request.rawHeaders
    .flatMap((value, index, all) =>
      index % 2 === 0 && value.toLowerCase() === "authorization" ? [all[index + 1]] : [],
    )
    .filter((value): value is string => value !== undefined)
  if (values.length !== 1) return undefined
  return /^Bearer ([^ ]+)$/.exec(values[0] ?? "")?.[1]
}

function segment(value: string | undefined): string {
  if (value === undefined) throw new URIError("path segment is missing")
  return decodeURIComponent(value)
}

function written(response: ServerResponse, status: number, body: unknown): true {
  writeJson(response, status, body)
  return true
}

function handleRuntimeError(response: ServerResponse, error: unknown): void {
  if (error instanceof RuntimeAuthenticationError) {
    writeRuntimeError(response, 401, "unauthenticated")
    return
  }
  if (error instanceof RunNotActiveError) {
    writeRuntimeError(response, 409, "run_not_active")
    return
  }
  if (error instanceof RuntimeConflictError) {
    writeRuntimeError(response, error.code === "snapshot_expired" ? 410 : 409, error.code)
    return
  }
  if (
    error instanceof z.ZodError ||
    error instanceof SyntaxError ||
    error instanceof URIError ||
    error instanceof RequestBodyError
  ) {
    writeRuntimeError(response, 400, "invalid_argument")
    return
  }
  throw error
}

function writeRuntimeError(response: ServerResponse, status: number, code: string): void {
  writeJson(response, status, { error: { code, message: code, retryable: false, details: {} } })
}
