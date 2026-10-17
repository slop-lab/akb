import assert from "node:assert/strict"
import { createServer, type Server, type ServerResponse } from "node:http"
import { test } from "node:test"
import { z } from "zod"
import { runAgentCli } from "../src/agent-runtime/cli.ts"
import { parseProviderEnvironment } from "../src/agent-runtime/provider.ts"
import { createWorkspaceToolBundle, describeWorkspaceTools } from "../src/agent-tools/index.ts"

const PROVIDER_TOKEN = "provider-fixture-secret"
const WORKSPACE_TOKEN = "workspace-fixture-secret"

async function listen(): Promise<{ readonly server: Server; readonly origin: string }> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new TypeError("fixture address missing")
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}

function sendEvents(response: ServerResponse, events: readonly object[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end("data: [DONE]\n\n")
}

test("real Responses transport accepts a completed streaming text response", async () => {
  // Given
  let requests = 0
  const provider = await listen()
  provider.server.on("request", async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${PROVIDER_TOKEN}`)
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = z
      .object({ stream: z.literal(true), store: z.literal(false), input: z.array(z.unknown()) })
      .passthrough()
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
    assert.equal(body.input.length > 0, true)
    requests += 1
    const message = {
      id: "msg-1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "complete", annotations: [] }],
    }
    sendEvents(response, [
      {
        type: "response.output_item.added",
        sequence_number: 0,
        output_index: 0,
        item: { id: "msg-1", type: "message", role: "assistant", content: [] },
      },
      {
        type: "response.output_text.delta",
        sequence_number: 1,
        output_index: 0,
        item_id: "msg-1",
        content_index: 0,
        delta: "complete",
      },
      {
        type: "response.output_text.done",
        sequence_number: 2,
        output_index: 0,
        item_id: "msg-1",
        content_index: 0,
        text: "complete",
      },
      {
        type: "response.output_item.done",
        sequence_number: 3,
        output_index: 0,
        item_id: "msg-1",
        item: message,
      },
      {
        type: "response.completed",
        sequence_number: 4,
        response: {
          id: "response-1",
          object: "response",
          status: "completed",
          output: [message],
          usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
        },
      },
    ])
  })
  const stdout: string[] = []

  // When
  try {
    const exitCode = await runAgentCli({
      arguments: ["run", "respond"],
      environment: {
        AFW_AGENT_TOKEN: WORKSPACE_TOKEN,
        AFW_API_URL: provider.origin,
        AFW_WORKSPACE_ID: "workspace-1",
        PART_PROVIDER: "responses",
        PART_MODEL: "fixture-model",
        PART_MODEL_URL: `${provider.origin}/v1/responses`,
        PART_API_KEY: PROVIDER_TOKEN,
      },
      io: { stdout: (value) => stdout.push(value), stderr: () => undefined },
      dependencies: { createWorkspaceToolBundle, describeWorkspaceTools },
    })

    // Then
    assert.equal(exitCode, 0)
    assert.equal(requests, 1)
    assert.equal(stdout.join("").includes(PROVIDER_TOKEN), false)
  } finally {
    await close(provider.server)
  }
})

test("provider configuration rejects credential-bearing and remote plaintext endpoints", () => {
  // Given
  const configuration = {
    PART_PROVIDER: "chat",
    PART_MODEL: "fixture-model",
    PART_API_KEY: PROVIDER_TOKEN,
  } as const

  // When / Then
  assert.throws(() =>
    parseProviderEnvironment({
      ...configuration,
      PART_MODEL_URL: "https://embedded:credential@models.example.test/v1/chat",
    }),
  )
  assert.throws(() =>
    parseProviderEnvironment({
      ...configuration,
      PART_MODEL_URL: "http://models.example.test/v1/chat",
    }),
  )
})
