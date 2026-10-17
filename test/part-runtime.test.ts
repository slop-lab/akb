import assert from "node:assert/strict"
import { test } from "node:test"
import { localContext, schema, stringSchema } from "@slop-lab/part/contracts/index.js"
import { functionTool } from "@slop-lab/part/tools.js"
import { fakeModel } from "@slop-lab/part-plugins/testing/index.js"
import { createPartAgent, observeRun } from "../src/agent-runtime/agent.ts"
import { AgentCleanupError } from "../src/agent-runtime/errors.ts"
import { parseProviderEnvironment } from "../src/agent-runtime/provider.ts"
import { runPartPrompt } from "../src/agent-runtime/run.ts"

const uppercaseInput = schema(
  "test/uppercase-input",
  (value): value is { readonly text: string } =>
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "text") !== undefined &&
    typeof Reflect.get(value, "text") === "string",
)

const uppercase = functionTool({
  id: "uppercase",
  input: uppercaseInput,
  output: stringSchema,
  effects: "read",
  execute: ({ text }) => text.toUpperCase(),
})

test("Part wrapper completes a real model-tool-model loop while observing events", async () => {
  // Given
  const model = fakeModel([
    { toolCalls: [{ name: "uppercase", arguments: { text: "part" } }] },
    { text: "PART" },
  ])
  const agent = createPartAgent({
    model,
    tools: [uppercase],
    toolSchemas: {
      uppercase: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  })

  // When
  const started = await agent.start("uppercase part")
  assert.equal(started.ok, true)
  if (!started.ok) return
  const observed = await observeRun(started.value)

  // Then
  assert.equal(observed.outcome.phase, "completed")
  assert.ok(observed.events.some((event) => event.type === "part.tool/result"))
  assert.equal(model.requests.length, 2)
  const cleanup = await agent.dispose()
  assert.deepEqual(cleanup.errors, [])
})

test("Part wrapper requests cancellation and reports a cancelled tool run", async () => {
  // Given
  const waiting = functionTool({
    id: "waiting",
    input: stringSchema,
    output: stringSchema,
    effects: "read",
    execute: async (_input, context) =>
      new Promise<string>((resolve) => {
        context.signal.addEventListener("abort", () => resolve("cancelled"), { once: true })
      }),
  })
  const agent = createPartAgent({
    model: fakeModel([{ toolCalls: [{ name: "waiting", arguments: "wait" }] }]),
    tools: [waiting],
    toolSchemas: { waiting: { type: "string" } },
  })
  const started = await agent.start("wait")
  assert.equal(started.ok, true)
  if (!started.ok) return

  // When
  const cancellation = await started.value.requestCancel("test cancellation")
  const outcome = await started.value.done

  // Then
  assert.equal(cancellation.ok, true)
  assert.equal(outcome.phase, "cancelled")
  await agent.dispose()
})

test("Provider environment selects the Responses adapter without exposing its credential", async () => {
  // Given
  const environment = {
    PART_PROVIDER: "responses",
    PART_MODEL: "model-1",
    PART_MODEL_URL: "https://models.example.test/v1/responses",
    PART_API_KEY: "secret-value",
  }

  // When
  const configured = parseProviderEnvironment(environment)
  const binding = await configured.model.auth.bind(configured.model.profile, localContext())

  // Then
  assert.equal(configured.provider, "responses")
  assert.equal(configured.model.adapter.id, "part/openai-responses")
  assert.equal(configured.model.profile.endpoint, environment.PART_MODEL_URL)
  assert.equal(JSON.stringify(configured).includes("secret-value"), false)
  assert.equal(binding.ok, true)
})

test("completed run waits for cleanup and reports incomplete cleanup as terminal failure", async () => {
  // Given
  let releaseCleanup: (() => void) | undefined
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve
  })
  const records: string[] = []
  const running = runPartPrompt({
    model: fakeModel([{ text: "complete" }]),
    prompt: "run",
    output: (record) => records.push(JSON.stringify(record)),
    bundle: {
      tools: [],
      toolSchemas: {},
      catalog: [],
      close: async () => {
        await cleanupGate
        return {
          released: [],
          unresolved: [{ owner: "test", kind: "secret-kind", id: "secret-id" }],
          errors: [
            {
              code: "test.secret-cleanup",
              category: "unavailable",
              message: "secret cleanup detail",
              retry: "never",
            },
          ],
        }
      },
    },
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  // When
  assert.equal(
    records.some((record) => record.includes('"type":"done"')),
    false,
  )
  releaseCleanup?.()
  await assert.rejects(running, AgentCleanupError)

  // Then
  const terminal = records.filter((record) => record.includes('"type":"done"'))
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0]?.includes('"phase":"failed"'), true)
  assert.equal(terminal[0]?.includes("secret"), false)
})
