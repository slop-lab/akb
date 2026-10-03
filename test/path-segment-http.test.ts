import assert from "node:assert/strict"
import type { Server } from "node:http"
import { test } from "node:test"
import { InvalidArgumentErrorSchema } from "../src/http/error-schemas.ts"
import { createServer } from "../src/server.ts"
import type { WorkItemId, WorkspaceId } from "../src/work-items/identifiers.ts"
import type { CreateWorkItem, PatchWorkItem } from "../src/work-items/model.ts"
import type { WorkItemStore } from "../src/work-items/store.ts"
import { sendRawRequest } from "./raw-http-fixture.ts"

class CapturingStore implements WorkItemStore {
  readonly creates: CreateWorkItem[] = []
  readonly patches: PatchWorkItem[] = []
  readonly gets: WorkItemId[] = []
  readonly lists: WorkspaceId[] = []

  create(command: CreateWorkItem) {
    this.creates.push(command)
    return { kind: "capacity_exceeded", resource: "items", capacity: 0 } as const
  }

  patch(command: PatchWorkItem) {
    this.patches.push(command)
    return { kind: "not_found", id: command.id } as const
  }

  get(id: WorkItemId) {
    this.gets.push(id)
    return undefined
  }

  list(workspaceId: WorkspaceId) {
    this.lists.push(workspaceId)
    return { items: [], matched: 0 }
  }
}

const createBody = JSON.stringify({ title: "Title", accountableOwnerId: "owner", actorId: "actor" })
const patchBody = JSON.stringify({ actorId: "actor", baseRevision: 1, title: "Changed" })
type Operation = {
  readonly method: "GET" | "POST" | "PATCH"
  readonly path: (segment: string) => string
  readonly body?: string
  readonly headers?: Readonly<Record<string, string>>
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

test("all captured path segments reject unsafe decoding without store calls", async (context) => {
  // Given
  const store = new CapturingStore()
  const server = createServer(store)
  context.after(() => closeServer(server))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("missing address")
  const invalidSegments = ["%", "%2F", "%5C", "%20%20"]
  const operations = [
    { method: "GET", path: (segment: string) => `/api/workspaces/${segment}/work-items` },
    {
      method: "POST",
      path: (segment: string) => `/api/workspaces/${segment}/work-items`,
      body: createBody,
      headers: { "content-type": "application/json", "idempotency-key": "key" },
    },
    { method: "GET", path: (segment: string) => `/api/work-items/${segment}` },
    {
      method: "PATCH",
      path: (segment: string) => `/api/work-items/${segment}`,
      body: patchBody,
      headers: { "content-type": "application/json" },
    },
  ] satisfies readonly Operation[]

  // When / Then
  for (const operation of operations) {
    for (const segment of invalidSegments) {
      const response = await sendRawRequest({
        port: address.port,
        method: operation.method,
        path: operation.path(segment),
        ...(operation.body === undefined ? {} : { body: operation.body }),
        ...(operation.headers === undefined ? {} : { headers: operation.headers }),
      })
      assert.equal(response.status, 400)
      assert.equal(
        InvalidArgumentErrorSchema.parse(JSON.parse(response.body)).error.code,
        "invalid_argument",
      )
    }
  }
  assert.deepEqual(
    [store.creates.length, store.patches.length, store.gets.length, store.lists.length],
    [0, 0, 0, 0],
  )
})

test("all routes decode once and pass trimmed IDs to the store", async (context) => {
  // Given
  const store = new CapturingStore()
  const server = createServer(store)
  context.after(() => closeServer(server))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("missing address")

  // When
  await sendRawRequest({
    port: address.port,
    method: "GET",
    path: "/api/workspaces/%20team%20/work-items",
  })
  await sendRawRequest({
    port: address.port,
    method: "POST",
    path: "/api/workspaces/%252F/work-items",
    body: createBody,
    headers: { "content-type": "application/json", "idempotency-key": "key" },
  })
  await sendRawRequest({ port: address.port, method: "GET", path: "/api/work-items/%20item%20" })
  await sendRawRequest({
    port: address.port,
    method: "PATCH",
    path: "/api/work-items/%252F",
    body: patchBody,
    headers: { "content-type": "application/json" },
  })

  // Then
  assert.deepEqual(store.lists, ["team"])
  assert.deepEqual(
    store.creates.map((command) => command.workspaceId),
    ["%2F"],
  )
  assert.deepEqual(store.gets, ["item"])
  assert.deepEqual(
    store.patches.map((command) => command.id),
    ["%2F"],
  )
})
