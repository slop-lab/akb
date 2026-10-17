import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import { emptyCleanup, schema, stringSchema } from "@slop-lab/part/contracts/index.js"
import type { Contracts } from "@slop-lab/part/reference/index.js"
import { functionTool } from "@slop-lab/part/tools.js"
import { fakeModel } from "@slop-lab/part-plugins/testing/index.js"
import { startWorkspaceAcp } from "../src/agent-runtime/acp.ts"
import type { RuntimeDependencies } from "../src/agent-runtime/types.ts"

const inputSchema = schema(
  "test/write-input",
  (value): value is { readonly text: string } =>
    typeof value === "object" && value !== null && typeof Reflect.get(value, "text") === "string",
)

async function permissionScenario(
  approved: boolean,
  bundleCleanup: Contracts.CleanupReport = emptyCleanup(),
) {
  let executions = 0
  let closes = 0
  const tool = functionTool({
    id: "write-note",
    input: inputSchema,
    output: stringSchema,
    effects: "write",
    execute: ({ text }) => {
      executions += 1
      return text
    },
  })
  const dependencies: RuntimeDependencies = {
    createWorkspaceToolBundle: () => ({
      tools: [tool],
      toolSchemas: {
        "write-note": {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
      catalog: [],
      close: async () => {
        closes += 1
        return bundleCleanup
      },
    }),
    describeWorkspaceTools: () => [],
  }
  const input = new PassThrough()
  const output = new PassThrough()
  const responses = new Map<number, (value: object) => void>()
  const messages: unknown[] = []
  let buffered = ""
  output.setEncoding("utf8")
  output.on("data", (chunk: string) => {
    buffered += chunk
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) {
      if (line.length === 0) continue
      const message: unknown = JSON.parse(line)
      messages.push(message)
      if (typeof message !== "object" || message === null) continue
      const method = Reflect.get(message, "method")
      const id = Reflect.get(message, "id")
      if (method === "session/request_permission" && typeof id === "string") {
        input.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: approved
              ? { outcome: { outcome: "selected", optionId: "allow-once" } }
              : { outcome: { outcome: "cancelled" } },
          })}\n`,
        )
      } else if (typeof id === "number") {
        responses.get(id)?.(message)
        responses.delete(id)
      }
    }
  })
  const host = startWorkspaceAcp({
    dependencies,
    bundle: { origin: "http://127.0.0.1:3001", workspaceId: "test", token: () => "token" },
    model: () =>
      fakeModel([
        { toolCalls: [{ name: "write-note", arguments: { text: "hello" } }] },
        { text: "finished" },
      ]),
    input,
    output,
  })
  let nextId = 0
  const request = (method: string, params: Readonly<Record<string, unknown>>) => {
    nextId += 1
    const id = nextId
    const response = new Promise<object>((resolve) => {
      responses.set(id, resolve)
    })
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    return response
  }
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const created = await request("session/new", { cwd: "/workspace", mcpServers: [] })
  const sessionId = Reflect.get(Reflect.get(created, "result") ?? {}, "sessionId")
  assert.equal(typeof sessionId, "string")
  const prompted = await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "write a note" }],
  })
  assert.equal(Reflect.has(prompted, approved ? "result" : "error"), true, JSON.stringify(prompted))
  await request("session/close", { sessionId })
  input.end()
  const cleanup = await host.closed
  return { executions, closes, cleanup, prompted, messages }
}

test("ACP denies a write when the client declines permission and cleans up on EOF", async () => {
  // Given / When
  const result = await permissionScenario(false)

  // Then
  assert.equal(result.executions, 0)
  assert.equal(result.closes, 1)
  assert.deepEqual(result.cleanup.errors, [])
})

test("ACP executes one write when the client grants allow-once permission", async () => {
  // Given / When
  const result = await permissionScenario(true)

  // Then
  if (result.executions !== 1) throw new TypeError(JSON.stringify(result.messages))
  assert.equal(result.closes, 1)
})

test("ACP closed report retains incomplete session bundle cleanup", async () => {
  // Given / When
  const result = await permissionScenario(true, {
    released: [],
    unresolved: [{ owner: "test", kind: "private", id: "private" }],
    errors: [
      {
        code: "test.private",
        category: "internal",
        message: "private detail",
        retry: "never",
      },
    ],
  })

  // Then
  assert.equal(result.cleanup.unresolved.length, 1)
  assert.equal(result.cleanup.errors.length, 1)
})

test("host close waits for a bundle already closing through session close", async () => {
  // Given
  let releaseBundle: (() => void) | undefined
  let markCloseStarted: (() => void) | undefined
  const bundleGate = new Promise<void>((resolve) => {
    releaseBundle = resolve
  })
  const closeStarted = new Promise<void>((resolve) => {
    markCloseStarted = resolve
  })
  let closes = 0
  const dependencies: RuntimeDependencies = {
    createWorkspaceToolBundle: () => ({
      tools: [],
      toolSchemas: {},
      catalog: [],
      close: async () => {
        closes += 1
        markCloseStarted?.()
        await bundleGate
        return emptyCleanup()
      },
    }),
    describeWorkspaceTools: () => [],
  }
  const input = new PassThrough()
  const output = new PassThrough()
  const responses = new Map<number, (value: object) => void>()
  let buffered = ""
  output.setEncoding("utf8")
  output.on("data", (chunk: string) => {
    buffered += chunk
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) {
      if (line.length === 0) continue
      const message: unknown = JSON.parse(line)
      if (typeof message !== "object" || message === null) continue
      const id = Reflect.get(message, "id")
      if (typeof id !== "number") continue
      responses.get(id)?.(message)
      responses.delete(id)
    }
  })
  const host = startWorkspaceAcp({
    dependencies,
    bundle: { origin: "http://127.0.0.1:3001", workspaceId: "test", token: () => "token" },
    model: () => fakeModel([{ text: "unused" }]),
    input,
    output,
  })
  let nextId = 0
  const request = (method: string, params: Readonly<Record<string, unknown>>) => {
    nextId += 1
    const id = nextId
    const response = new Promise<object>((resolve) => responses.set(id, resolve))
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    return response
  }
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} })
  const created = await request("session/new", { cwd: "/workspace", mcpServers: [] })
  const sessionId = Reflect.get(Reflect.get(created, "result") ?? {}, "sessionId")
  assert.equal(typeof sessionId, "string")

  // When
  void request("session/close", { sessionId })
  await closeStarted
  let hostSettled = false
  const closing = host.close().then((report) => {
    hostSettled = true
    return report
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  // Then
  assert.equal(hostSettled, false)
  releaseBundle?.()
  const report = await closing
  assert.equal(closes, 1)
  assert.deepEqual(report.errors, [])
})
