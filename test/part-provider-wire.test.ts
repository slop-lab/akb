import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { test } from "node:test"
import { z } from "zod"
import { runAgentCli } from "../src/agent-runtime/cli.ts"
import { createWorkspaceToolBundle, describeWorkspaceTools } from "../src/agent-tools/index.ts"

const PROVIDER_TOKEN = "provider-fixture-secret"
const WORKSPACE_TOKEN = "workspace-fixture-secret"

const ChatRequestSchema = z
  .object({
    stream: z.literal(true),
    model: z.string(),
    messages: z.array(z.object({ role: z.string() }).passthrough()),
    tools: z.array(z.object({ type: z.literal("function") }).passthrough()),
  })
  .passthrough()

type ListeningServer = {
  readonly server: Server
  readonly origin: string
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<ListeningServer> {
  const server = createServer((request, response) => void handler(request, response))
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

test("real Chat transport completes a workspace tool loop without exposing credentials", async () => {
  // Given
  const providerBodies: string[] = []
  let workspaceRequests = 0
  const workspace = await listen((request, response) => {
    assert.equal(request.method, "GET")
    assert.equal(request.url, "/api/human/v1/workspaces/workspace-1/spaces")
    assert.equal(request.headers.authorization, `Bearer ${WORKSPACE_TOKEN}`)
    workspaceRequests += 1
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ spaces: [] }))
  })
  const provider = await listen(async (request, response) => {
    assert.equal(request.method, "POST")
    assert.equal(request.url, "/v1/chat/completions")
    assert.equal(request.headers.authorization, `Bearer ${PROVIDER_TOKEN}`)
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString("utf8")
    providerBodies.push(body)
    const parsed = ChatRequestSchema.parse(JSON.parse(body))
    const hasToolResult = parsed.messages.some((message) => message.role === "tool")
    if (hasToolResult) {
      sendEvents(response, [
        {
          id: "chat-final",
          choices: [{ index: 0, delta: { content: "complete" }, finish_reason: null }],
        },
        {
          id: "chat-final",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        },
      ])
      return
    }
    assert.equal(
      parsed.tools.some(
        (tool) => Reflect.get(Reflect.get(tool, "function") ?? {}, "name") === "workspace_spaces",
      ),
      true,
    )
    sendEvents(response, [
      {
        id: "chat-tool",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-spaces",
                  type: "function",
                  function: { name: "workspace_spaces", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "chat-tool",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ])
  })
  const stdout: string[] = []
  const stderr: string[] = []

  // When
  try {
    const exitCode = await runAgentCli({
      arguments: ["run", "inspect the workspace"],
      environment: {
        AFW_AGENT_TOKEN: WORKSPACE_TOKEN,
        AFW_API_URL: workspace.origin,
        AFW_WORKSPACE_ID: "workspace-1",
        PART_PROVIDER: "chat",
        PART_MODEL: "fixture-model",
        PART_MODEL_URL: `${provider.origin}/v1/chat/completions`,
        PART_API_KEY: PROVIDER_TOKEN,
      },
      io: {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
      dependencies: { createWorkspaceToolBundle, describeWorkspaceTools },
    })

    // Then
    assert.equal(exitCode, 0, stderr.join(""))
    assert.equal(providerBodies.length, 2)
    assert.equal(workspaceRequests, 1)
    assert.equal(
      providerBodies.some((body) => body.includes(WORKSPACE_TOKEN)),
      false,
    )
    assert.equal(stdout.join("").includes(PROVIDER_TOKEN), false)
    assert.equal(stdout.join("").includes(WORKSPACE_TOKEN), false)
    const records = stdout.map((line) => JSON.parse(line))
    assert.equal(
      records.some((record) => Reflect.get(record, "event") === "part.tool/result"),
      true,
    )
    assert.equal(
      records.some((record) => Reflect.get(record, "phase") === "completed"),
      true,
    )
  } finally {
    await Promise.all([close(provider.server), close(workspace.server)])
  }
})
