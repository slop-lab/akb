import type { IncomingMessage, ServerResponse } from "node:http"
import type { WorkItemStore } from "../work-items/store.ts"
import { parsePathSegment } from "./path-segment.ts"
import { invalidArgument, notFound, writeJson } from "./responses.ts"
import { WorkItemPathSchema } from "./schemas.ts"
import { writeWorkItemList } from "./work-item-list.ts"
import {
  createWorkItem,
  patchWorkItem,
  type WorkItemWriteContext,
} from "./work-item-write-routes.ts"

export async function routeWorkItems(
  request: IncomingMessage,
  response: ServerResponse,
  store: WorkItemStore,
): Promise<boolean> {
  const path = request.url?.split("?", 1)[0] ?? "/"
  const writeContext = { request, response, store } satisfies WorkItemWriteContext
  const workspaceMatch = /^\/api\/workspaces\/([^/]+)\/work-items$/.exec(path)
  if (workspaceMatch !== null) {
    if (request.method === "POST") {
      await createWorkItem(writeContext, workspaceMatch[1])
      return true
    }
    if (request.method === "GET") {
      writeWorkItemList(response, store, workspaceMatch[1])
      return true
    }
  }

  const itemMatch = /^\/api\/work-items\/([^/]+)$/.exec(path)
  if (itemMatch !== null) {
    if (request.method === "GET") {
      getWorkItem(response, store, itemMatch[1])
      return true
    }
    if (request.method === "PATCH") {
      await patchWorkItem(writeContext, itemMatch[1])
      return true
    }
  }
  return false
}

function getWorkItem(
  response: ServerResponse,
  store: WorkItemStore,
  rawId: string | undefined,
): void {
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
  const item = store.get(id.value)
  if (item === undefined) {
    notFound(response, id.value)
    return
  }
  writeJson(response, 200, { item })
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected path result: ${JSON.stringify(value)}`)
}
