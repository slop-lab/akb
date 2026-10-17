import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { test } from "node:test"
import { type Contracts, localContext } from "@slop-lab/part/contracts/index.js"
import { createToolDispatcher } from "@slop-lab/part/tools.js"
import { fakeModel } from "@slop-lab/part-plugins/testing/index.js"
import { createPartAgent, observeRun } from "../src/agent-runtime/agent.ts"
import type { WorkspaceToolBundle } from "../src/agent-runtime/types.ts"
import { createWorkspaceToolBundle } from "../src/agent-tools/index.ts"

type SeenRequest = {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly authorization: string | undefined
  readonly body: string
}

test("workspace read dispatch crosses the real Part model-tool loop", async (context) => {
  const seen: SeenRequest[] = []
  const fixture = await serve(async (request, response) => {
    seen.push(await capture(request))
    json(response, 200, { spaces: [] })
  })
  context.after(fixture.close)
  const bundle = workspaceBundle(fixture.origin)
  const model = fakeModel([
    { toolCalls: [{ name: "workspace_spaces", arguments: {} }] },
    { text: "No visible spaces." },
  ])
  const agent = createPartAgent({ model, tools: bundle.tools, toolSchemas: bundle.toolSchemas })

  const started = await agent.start("List spaces")
  assert.equal(started.ok, true)
  if (!started.ok) return
  const observed = await observeRun(started.value)

  assert.equal(observed.outcome.phase, "completed")
  assert.ok(observed.events.some((event) => event.type === "part.tool/result"))
  assert.equal(model.requests.length, 2)
  assert.equal(seen[0]?.url, "/api/human/v1/workspaces/workspace-1/spaces")
  assert.equal(seen[0]?.authorization, "Bearer host-secret")
  await agent.dispose()
  await bundle.close()
})

test("allowlisted command sends an actor-free revisioned envelope", async (context) => {
  const seen: SeenRequest[] = []
  const fixture = await serve(async (request, response) => {
    seen.push(await capture(request))
    json(response, 200, { result: { id: "comment-1" } })
  })
  context.after(fixture.close)
  const bundle = workspaceBundle(fixture.origin, ["comment.create"])

  const outcome = await dispatch(bundle, "command_comment_create", {
    parentId: "work/one",
    baseRevision: 7,
    payload: { body: "hello" },
  })

  assert.equal(outcome.phase, "completed")
  assert.equal(seen[0]?.method, "POST")
  assert.equal(seen[0]?.url, "/api/commands/v1/workspaces/workspace-1/entities/work%2Fone/comments")
  const body: unknown = JSON.parse(seen[0]?.body ?? "null")
  assert.equal(typeof body === "object" && body !== null && "actor" in body, false)
  assert.equal(Reflect.get(body ?? {}, "baseRevision"), 7)
  assert.match(String(Reflect.get(body ?? {}, "idempotencyKey")), /^agent-/)
  await bundle.close()
})

test("dispatcher rejects extra model input and unavailable authority tools", async () => {
  const bundle = workspaceBundle("http://127.0.0.1:3001")
  const dispatcher = createToolDispatcher({ tools: bundle.tools })
  assert.equal(dispatcher.ok, true)
  if (!dispatcher.ok) return

  const invalid = await dispatcher.value.dispatch(
    { logicalCallId: "invalid", toolId: "workspace_spaces", arguments: { unexpected: true } },
    localContext(),
  )
  const authority = await dispatcher.value.dispatch(
    { logicalCallId: "authority", toolId: "command_entity_access", arguments: {} },
    localContext(),
  )

  assert.equal(invalid.ok, false)
  assert.equal(authority.ok, false)
  await bundle.close()
})

test("transport rejects redirects, limits, and sanitized HTTP errors", async (context) => {
  let redirectReached = false
  const fixture = await serve(async (request, response) => {
    await capture(request)
    if (request.url?.endsWith("/redirect-target")) {
      redirectReached = true
      json(response, 200, { spaces: [] })
      return
    }
    if (request.headers.authorization === "Bearer redirect") {
      response.writeHead(302, { location: `${fixture.origin}/redirect-target` })
      response.end()
      return
    }
    if (request.headers.authorization === "Bearer large") {
      json(response, 200, { spaces: [], padding: "x".repeat(100) })
      return
    }
    if (request.headers.authorization === "Bearer timeout") return
    json(response, 403, { error: { code: "permission_denied", message: "host-secret" } })
  })
  context.after(fixture.close)

  const denied = workspaceBundle(fixture.origin)
  const deniedOutcome = await dispatch(denied, "workspace_spaces", {})
  assert.equal(deniedOutcome.phase, "failed")
  assert.equal(JSON.stringify(deniedOutcome).includes("host-secret"), false)
  await denied.close()

  const redirectBundle = createWorkspaceToolBundle({
    origin: fixture.origin,
    workspaceId: "workspace-1",
    token: () => "redirect",
    maxResponseBytes: 32,
  })
  const redirectOutcome = await dispatch(redirectBundle, "workspace_spaces", {})
  assert.equal(redirectOutcome.phase, "failed")
  assert.equal(redirectReached, false)
  await redirectBundle.close()

  const limitedBundle = createWorkspaceToolBundle({
    origin: fixture.origin,
    workspaceId: "workspace-1",
    token: () => "large",
    maxResponseBytes: 32,
  })
  const limitedOutcome = await dispatch(limitedBundle, "workspace_spaces", {})
  assert.equal(limitedOutcome.phase, "failed")
  await limitedBundle.close()

  const timeoutBundle = createWorkspaceToolBundle({
    origin: fixture.origin,
    workspaceId: "workspace-1",
    token: () => "timeout",
    timeoutMs: 20,
  })
  const timeoutOutcome = await dispatch(timeoutBundle, "workspace_spaces", {})
  assert.equal(timeoutOutcome.phase, "failed")
  await timeoutBundle.close()
})

test("abort cancels an in-flight workspace request", async (context) => {
  let markStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const fixture = await serve(async (request) => {
    await capture(request)
    markStarted?.()
  })
  context.after(fixture.close)
  const bundle = workspaceBundle(fixture.origin)
  const controller = new AbortController()

  const pending = dispatch(bundle, "workspace_spaces", {}, controller.signal)
  await started
  controller.abort()
  const outcome = await pending

  assert.equal(outcome.phase, "cancelled")
  await bundle.close()
})

test("bundle close releases captured snapshots once", async (context) => {
  const released: string[] = []
  const snapshotId = "123e4567-e89b-42d3-a456-426614174000"
  const fixture = await serve(async (request, response) => {
    await capture(request)
    if (request.method === "DELETE") {
      released.push(request.url ?? "")
      response.writeHead(204).end()
      return
    }
    json(response, 200, {
      snapshot: { id: snapshotId, expiresAt: "2026-10-17T20:00:00.000Z" },
      items: [],
      matched: 0,
      nextCursor: null,
    })
  })
  context.after(fixture.close)
  const bundle = workspaceBundle(fixture.origin)
  const input = {
    filter: null,
    search: null,
    sort: [{ field: "createdAt", direction: "asc" }],
    includeArchived: false,
    page: { size: 10, cursor: null },
  }

  const outcome = await dispatch(bundle, "projects_query", input)
  const first = await bundle.close()
  const second = await bundle.close()

  assert.equal(outcome.phase, "completed")
  assert.equal(released.length, 1)
  assert.equal(first.released[0]?.id, snapshotId)
  assert.deepEqual(second, first)
})

function workspaceBundle(origin: string, allowedActions: readonly "comment.create"[] = []) {
  return createWorkspaceToolBundle({
    origin,
    workspaceId: "workspace-1",
    token: () => "host-secret",
    allowedActions,
  })
}

async function dispatch(
  bundle: WorkspaceToolBundle,
  toolId: string,
  arguments_: Contracts.Json,
  signal = new AbortController().signal,
) {
  const dispatcher = createToolDispatcher({ tools: bundle.tools })
  assert.equal(dispatcher.ok, true)
  if (!dispatcher.ok) throw new TypeError("dispatcher setup failed")
  const called = await dispatcher.value.dispatch(
    { logicalCallId: "test-call", toolId, arguments: arguments_ },
    localContext({ signal }),
  )
  assert.equal(called.ok, true)
  if (!called.ok) throw new TypeError("dispatch admission failed")
  return called.value.done
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
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

async function capture(request: IncomingMessage): Promise<SeenRequest> {
  const chunks: Uint8Array[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return {
    method: request.method,
    url: request.url,
    authorization: request.headers.authorization,
    body: Buffer.concat(chunks).toString("utf8"),
  }
}

function json(response: ServerResponse, status: number, value: Contracts.Json): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}
