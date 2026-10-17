import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { emptyCleanup } from "@slop-lab/part/contracts/index.js"
import { fakeModel } from "@slop-lab/part-plugins/testing/index.js"
import { runAgentCli } from "../src/agent-runtime/cli.ts"
import type { RuntimeDependencies } from "../src/agent-runtime/types.ts"

function fixture() {
  const stdout: string[] = []
  const stderr: string[] = []
  const dependencies: RuntimeDependencies = {
    createWorkspaceToolBundle: () => ({
      tools: [],
      toolSchemas: {},
      catalog: [],
      close: async () => emptyCleanup(),
    }),
    describeWorkspaceTools: () => [
      { id: "work.search", description: "Search work", effects: "read", inputSchema: {} },
    ],
    demoModel: () => fakeModel([{ text: "demo reply" }]),
  }
  return {
    dependencies,
    stdout,
    stderr,
    io: {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    },
  }
}

test("CLI demo runs locally without provider or workspace credentials", async () => {
  // Given
  const context = fixture()

  // When
  const exitCode = await runAgentCli({
    arguments: ["demo", "hello"],
    environment: {},
    io: context.io,
    dependencies: context.dependencies,
  })

  // Then
  assert.equal(exitCode, 0)
  const records = context.stdout.map((line) => JSON.parse(line))
  assert.equal(
    records.some((record) => Reflect.get(record, "type") === "done"),
    true,
  )
  assert.deepEqual(context.stderr, [])
})

test("CLI tools prints the static catalog without credentials", async () => {
  // Given
  const context = fixture()

  // When
  const exitCode = await runAgentCli({
    arguments: ["tools"],
    environment: {},
    io: context.io,
    dependencies: context.dependencies,
  })

  // Then
  assert.equal(exitCode, 0)
  assert.equal(Reflect.get(JSON.parse(context.stdout[0] ?? "{}"), "id"), "work.search")
})

test("CLI rejects unknown options without echoing environment secrets", async () => {
  // Given
  const context = fixture()
  const environment = { PART_API_KEY: "never-print-this" }

  // When
  const exitCode = await runAgentCli({
    arguments: ["run", "hello", "--unknown"],
    environment,
    io: context.io,
    dependencies: context.dependencies,
  })

  // Then
  assert.equal(exitCode, 1)
  assert.equal(context.stderr.join("").includes(environment.PART_API_KEY), false)
  assert.equal(context.stderr.join("").includes("unknown option"), true)
})

test("CLI refuses an agent command below Node 24.22", async () => {
  // Given
  const context = fixture()

  // When
  const exitCode = await runAgentCli({
    arguments: ["--help"],
    environment: {},
    io: context.io,
    dependencies: context.dependencies,
    runtime: { nodeVersion: "24.21.0" },
  })

  // Then
  assert.equal(exitCode, 1)
  assert.equal(context.stderr.join("").includes("24.22.0 or newer"), true)
})

test("CLI exits nonzero and sanitizes an incomplete completed-run cleanup", async () => {
  // Given
  const context = fixture()
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        choices: [
          { index: 0, message: { role: "assistant", content: "complete" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new TypeError("fixture address missing")
  const dependencies: RuntimeDependencies = {
    ...context.dependencies,
    createWorkspaceToolBundle: () => ({
      tools: [],
      toolSchemas: {},
      catalog: [],
      close: async () => ({
        released: [],
        unresolved: [{ owner: "test", kind: "hidden", id: "hidden" }],
        errors: [
          {
            code: "test.hidden",
            category: "internal",
            message: "hidden cleanup detail",
            retry: "never",
          },
        ],
      }),
    }),
  }

  // When
  try {
    const exitCode = await runAgentCli({
      arguments: ["run", "complete"],
      environment: {
        AFW_AGENT_TOKEN: "workspace-token",
        AFW_API_URL: `http://127.0.0.1:${address.port}`,
        AFW_WORKSPACE_ID: "workspace",
        PART_PROVIDER: "chat",
        PART_MODEL: "fixture",
        PART_MODEL_URL: `http://127.0.0.1:${address.port}/chat`,
        PART_API_KEY: "provider-token",
      },
      io: context.io,
      dependencies,
    })

    // Then
    assert.equal(exitCode, 1)
    assert.equal(
      context.stdout.some((line) => line.includes('"phase":"failed"')),
      true,
    )
    assert.equal(context.stdout.join("").includes("hidden"), false)
    assert.equal(context.stderr.join(""), "agent cleanup incomplete\n")
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  }
})
