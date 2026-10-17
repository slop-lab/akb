import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { performance } from "node:perf_hooks"
import { test } from "node:test"
import { type Contracts, localContext } from "@slop-lab/part/contracts/index.js"
import { createToolDispatcher } from "@slop-lab/part/tools.js"
import type { WorkspaceToolBundle } from "../src/agent-runtime/types.ts"
import { createWorkspaceToolBundle } from "../src/agent-tools/index.ts"

const PROJECT_QUERY = {
  filter: null,
  search: null,
  sort: [{ field: "createdAt", direction: "asc" }],
  includeArchived: false,
  page: { size: 10, cursor: null },
} as const

test("write tools never advertise automatic retry safety", async () => {
  const bundle = createWorkspaceToolBundle({
    origin: "http://127.0.0.1:3001",
    workspaceId: "workspace-1",
    token: () => "unused",
    allowedActions: ["comment.create"],
  })
  const dispatcher = createToolDispatcher({ tools: bundle.tools })
  assert.equal(dispatcher.ok, true)
  if (!dispatcher.ok) return

  const definition = dispatcher.value.registry.resolve("command_comment_create")

  assert.equal(definition.ok, true)
  if (definition.ok) assert.equal(definition.value.retrySafety, "never")
  await bundle.close()
})

test("malformed query responses still release their raw snapshot", async (context) => {
  const snapshotId = "123e4567-e89b-42d3-a456-426614174000"
  const released: string[] = []
  const fixture = await serve(async (request, response) => {
    await drain(request)
    if (request.method === "DELETE") {
      released.push(request.url ?? "")
      response.writeHead(204).end()
      return
    }
    json(response, { snapshot: { id: snapshotId }, items: "invalid" })
  })
  context.after(fixture.close)
  const bundle = workspaceBundle(fixture.origin)

  const outcome = await dispatch(bundle, "projects_query", PROJECT_QUERY)
  const cleanup = await bundle.close()

  assert.equal(outcome.phase, "failed")
  assert.equal(released.length, 1)
  assert.equal(cleanup.released[0]?.id, snapshotId)
})

test("close aborts and awaits an in-flight read", async (context) => {
  let markStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const fixture = await serve(async (request) => {
    await drain(request)
    markStarted?.()
  })
  context.after(fixture.close)
  const bundle = workspaceBundle(fixture.origin)
  const pending = dispatch(bundle, "projects_query", PROJECT_QUERY)
  let dispatchSettled = false
  void pending.then(() => {
    dispatchSettled = true
  })
  await started

  const cleanup = await bundle.close()
  const outcome = await pending

  assert.notEqual(outcome.phase, "completed")
  assert.equal(dispatchSettled, true)
  assert.deepEqual(cleanup, { released: [], unresolved: [], errors: [] })
})

test("snapshot cleanup has bounded concurrency and total duration", async (context) => {
  let queryCount = 0
  let activeDeletes = 0
  let peakDeletes = 0
  const createdSnapshots: string[] = []
  const fixture = await serve(async (request, response) => {
    await drain(request)
    if (request.method === "DELETE") {
      activeDeletes += 1
      peakDeletes = Math.max(peakDeletes, activeDeletes)
      request.once("close", () => {
        activeDeletes -= 1
      })
      return
    }
    queryCount += 1
    const snapshotId = `123e4567-e89b-42d3-a456-42661417400${queryCount}`
    createdSnapshots.push(snapshotId)
    json(response, page(snapshotId))
  })
  context.after(fixture.close)
  const bundle = workspaceBundle(fixture.origin, 60)
  for (let index = 0; index < 6; index += 1) {
    const outcome = await dispatch(bundle, "projects_query", PROJECT_QUERY)
    assert.equal(outcome.phase, "completed")
  }

  const started = performance.now()
  const cleanup = await bundle.close()
  const elapsedMs = performance.now() - started

  assert.equal(cleanup.unresolved.length, 6)
  assert.equal(cleanup.errors.length, 6)
  assert.deepEqual(
    cleanup.unresolved.map((reference) => reference.id).sort(),
    createdSnapshots.sort(),
  )
  assert.ok(peakDeletes >= 2)
  assert.ok(peakDeletes <= 4)
  assert.ok(elapsedMs < 180, `cleanup took ${elapsedMs}ms`)
})

function workspaceBundle(origin: string, timeoutMs = 15_000): WorkspaceToolBundle {
  return createWorkspaceToolBundle({
    origin,
    workspaceId: "workspace-1",
    token: () => "host-secret",
    timeoutMs,
  })
}

async function dispatch(bundle: WorkspaceToolBundle, toolId: string, arguments_: Contracts.Json) {
  const dispatcher = createToolDispatcher({ tools: bundle.tools })
  assert.equal(dispatcher.ok, true)
  if (!dispatcher.ok) throw new TypeError("dispatcher setup failed")
  const called = await dispatcher.value.dispatch(
    { logicalCallId: crypto.randomUUID(), toolId, arguments: arguments_ },
    localContext(),
  )
  assert.equal(called.ok, true)
  if (!called.ok) throw new TypeError("dispatch admission failed")
  return called.value.done
}

function page(snapshotId: string): Contracts.Json {
  return {
    snapshot: { id: snapshotId, expiresAt: "2026-10-17T20:00:00.000Z" },
    items: [],
    matched: 0,
    nextCursor: null,
  }
}

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  const server = createServer((request, response) => void handler(request, response))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new TypeError("missing fixture address")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function drain(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) void _chunk
}

function json(response: ServerResponse, value: Contracts.Json): void {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}
