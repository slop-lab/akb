import type { IncomingMessage, ServerResponse } from "node:http"
import type { ZodError } from "zod"
import type { WorkItemStore } from "../work-items/store.ts"
import { parsePathSegment } from "./path-segment.ts"
import { readJson } from "./request-body.ts"
import {
  budgetExceeded,
  capacityExceeded,
  idempotencyConflict,
  invalidArgument,
  notFound,
  revisionConflict,
  writeJson,
} from "./responses.ts"
import {
  CreateWorkItemBodySchema,
  IdempotencyHeaderSchema,
  PatchWorkItemBodySchema,
  WorkItemPathSchema,
  WorkspacePathSchema,
} from "./schemas.ts"

export type WorkItemWriteContext = {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly store: WorkItemStore
}

export async function createWorkItem(
  { request, response, store }: WorkItemWriteContext,
  rawWorkspaceId: string | undefined,
): Promise<void> {
  const workspace = parsePathSegment(rawWorkspaceId, "workspaceId", WorkspacePathSchema)
  switch (workspace.kind) {
    case "invalid":
      invalidArgument(response, workspace.fieldErrors)
      return
    case "valid":
      break
    default:
      assertNever(workspace)
  }
  const body = await readJson(request)
  const key = IdempotencyHeaderSchema.safeParse(request.headers["idempotency-key"])
  let value: unknown
  switch (body.kind) {
    case "aborted":
      response.destroy()
      return
    case "too_large":
      budgetExceeded(response, body.limit)
      return
    case "invalid":
      invalidArgument(response, [
        { field: "body", message: "body must be valid JSON" },
        ...issuesFor("Idempotency-Key", key.error),
      ])
      return
    case "parsed":
      value = body.value
      break
    default:
      return assertNever(body)
  }

  const parsedBody = CreateWorkItemBodySchema.safeParse(value)
  if (!key.success || !parsedBody.success) {
    invalidArgument(response, [
      ...issuesFor("Idempotency-Key", key.error),
      ...issuesFor("body", parsedBody.error),
    ])
    return
  }

  const result = await store.create({
    workspaceId: workspace.value,
    title: parsedBody.data.title,
    accountableOwnerId: parsedBody.data.accountableOwnerId,
    actorId: parsedBody.data.actorId,
    idempotencyKey: key.data,
  })
  switch (result.kind) {
    case "created":
    case "replayed":
      writeJson(response, 201, { item: result.item })
      return
    case "idempotency_conflict":
      idempotencyConflict(response, result.idempotencyKey)
      return
    case "capacity_exceeded":
      capacityExceeded(response, result)
      return
    default:
      return assertNever(result)
  }
}

export async function patchWorkItem(
  { request, response, store }: WorkItemWriteContext,
  rawId: string | undefined,
): Promise<void> {
  const id = parsePathSegment(rawId, "id", WorkItemPathSchema)
  switch (id.kind) {
    case "invalid":
      invalidArgument(response, id.fieldErrors)
      return
    case "valid":
      break
    default:
      assertNever(id)
  }
  const body = await readJson(request)
  let value: unknown
  switch (body.kind) {
    case "aborted":
      response.destroy()
      return
    case "too_large":
      budgetExceeded(response, body.limit)
      return
    case "invalid":
      invalidArgument(response, [{ field: "body", message: "body must be valid JSON" }])
      return
    case "parsed":
      value = body.value
      break
    default:
      return assertNever(body)
  }

  const parsedBody = PatchWorkItemBodySchema.safeParse(value)
  if (!parsedBody.success) {
    invalidArgument(response, [...issuesFor("body", parsedBody.error)])
    return
  }

  const result = await store.patch({
    id: id.value,
    actorId: parsedBody.data.actorId,
    baseRevision: parsedBody.data.baseRevision,
    ...(parsedBody.data.title === undefined ? {} : { title: parsedBody.data.title }),
    ...(parsedBody.data.state === undefined ? {} : { state: parsedBody.data.state }),
  })
  switch (result.kind) {
    case "updated":
    case "unchanged":
      writeJson(response, 200, { item: result.item })
      return
    case "not_found":
      notFound(response, result.id)
      return
    case "revision_conflict":
      revisionConflict(response, result.expected, result.actual)
      return
    case "capacity_exceeded":
      capacityExceeded(response, result)
      return
    default:
      return assertNever(result)
  }
}

function issuesFor(prefix: string, error: ZodError | undefined) {
  return (
    error?.issues.map((issue) => ({
      field: [prefix, ...issue.path.map(String)].filter((part) => part.length > 0).join("."),
      message: issue.message,
    })) ?? []
  )
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected result: ${JSON.stringify(value)}`)
}
