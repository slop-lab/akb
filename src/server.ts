import { randomUUID } from "node:crypto"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { createServer as createHttpServer } from "node:http"
import { isRequestAborted } from "./http/request-state.ts"
import { internalError, routeNotFound } from "./http/responses.ts"
import { routeWorkItems } from "./http/work-item-routes.ts"
import { eventId, workItemId } from "./work-items/identifiers.ts"
import { InMemoryWorkItemStore, type StoreDependencies } from "./work-items/in-memory-store.ts"
import type { WorkItemStore } from "./work-items/store.ts"

const HEALTH_RESPONSE = JSON.stringify({ status: "ok" })

const DEFAULT_DEPENDENCIES: StoreDependencies = {
  newWorkItemId: () => workItemId(randomUUID()),
  newEventId: () => eventId(randomUUID()),
  now: () => new Date().toISOString(),
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: WorkItemStore,
): Promise<void> {
  const path = request.url?.split("?", 1)[0] ?? "/"
  if (request.method === "GET" && path === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
    response.end(HEALTH_RESPONSE)
    return
  }

  if (await routeWorkItems(request, response, store)) return

  routeNotFound(response, request.method ?? "UNKNOWN", path)
}

function createDefaultStore(): InMemoryWorkItemStore {
  return new InMemoryWorkItemStore(DEFAULT_DEPENDENCIES)
}

export function createServer(store: WorkItemStore = createDefaultStore()): Server {
  return createHttpServer((request, response) => {
    handleRequest(request, response, store).catch(() => {
      if (isRequestAborted(request)) {
        response.destroy()
        return
      }
      if (!response.headersSent && !response.writableEnded) {
        internalError(response)
        return
      }
      response.destroy()
    })
  })
}
