import assert from "node:assert/strict"
import { connect } from "node:net"
import { test } from "node:test"
import { MAX_JSON_BODY_BYTES } from "../src/http/request-body.ts"
import { createServer } from "../src/server.ts"
import type { WorkItemId, WorkspaceId } from "../src/work-items/identifiers.ts"
import type { CreateWorkItem, PatchWorkItem } from "../src/work-items/model.ts"
import type { WorkItemStore } from "../src/work-items/store.ts"
import { sendRawRequest } from "./raw-http-fixture.ts"

class CountingStore implements WorkItemStore {
  createCalls = 0

  create(_command: CreateWorkItem) {
    this.createCalls += 1
    return { kind: "capacity_exceeded", resource: "items", capacity: 0 } as const
  }

  patch(command: PatchWorkItem) {
    return { kind: "not_found", id: command.id } as const
  }

  get(_id: WorkItemId) {
    return undefined
  }

  list(_workspaceId: WorkspaceId) {
    return { items: [], matched: 0 }
  }
}

test("an exactly 65536-byte valid JSON body reaches normal validation", async (context) => {
  // Given
  const store = new CountingStore()
  const server = createServer(store)
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("missing address")
  const prefix = '{"padding":"'
  const suffix = '"}'
  const body = `${prefix}${"x".repeat(MAX_JSON_BODY_BYTES - prefix.length - suffix.length)}${suffix}`

  // When
  const response = await sendRawRequest({
    port: address.port,
    method: "POST",
    path: "/api/workspaces/workspace/work-items",
    body,
    headers: { "content-type": "application/json", "idempotency-key": "key" },
  })

  // Then
  assert.equal(Buffer.byteLength(body), MAX_JSON_BODY_BYTES)
  assert.equal(response.status, 400)
  assert.equal(store.createCalls, 0)
})

test("an aborted partial create never invokes the store and server stays healthy", async (context) => {
  // Given
  const store = new CountingStore()
  const server = createServer(store)
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("missing address")
  const socket = connect(address.port, "127.0.0.1")
  await new Promise<void>((resolve) => socket.once("connect", resolve))

  // When
  socket.write(
    "POST /api/workspaces/workspace/work-items HTTP/1.1\r\nHost: localhost\r\n" +
      "Content-Type: application/json\r\nIdempotency-Key: aborted\r\nContent-Length: 100\r\n\r\n{",
  )
  socket.destroy()
  await new Promise<void>((resolve) => socket.once("close", resolve))
  const health = await sendRawRequest({ port: address.port, method: "GET", path: "/health" })

  // Then
  assert.equal(store.createCalls, 0)
  assert.equal(health.status, 200)
  assert.deepEqual(JSON.parse(health.body), { status: "ok" })
})

test("raw Idempotency-Key bytes enforce visible ASCII and the 200-character limit", async (context) => {
  // Given
  const store = new CountingStore()
  const server = createServer(store)
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("missing address")
  const body = JSON.stringify({ title: "Title", accountableOwnerId: "owner", actorId: "actor" })
  const cases = [
    { value: "x".repeat(200), status: 507 },
    { value: "x".repeat(201), status: 400 },
    { value: "😀", status: 400 },
    { value: "has space", status: 400 },
    { value: "has\ttab", status: 400 },
    { value: "has\u0001control", status: 400 },
  ] as const

  // When / Then
  for (const testCase of cases) {
    const socket = connect(address.port, "127.0.0.1")
    await new Promise<void>((resolve) => socket.once("connect", resolve))
    socket.setEncoding("utf8")
    socket.end(
      `POST /api/workspaces/workspace/work-items HTTP/1.1\r\nHost: localhost\r\n` +
        `Content-Type: application/json\r\nIdempotency-Key: ${testCase.value}\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    )
    let rawResponse = ""
    for await (const chunk of socket) rawResponse += chunk
    assert.equal(Number(rawResponse.split(" ", 2)[1]), testCase.status)
  }
  assert.equal(store.createCalls, 1)
})
