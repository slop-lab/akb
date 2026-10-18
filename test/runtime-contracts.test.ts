import assert from "node:assert/strict"
import { test } from "node:test"
import {
  ActivityInputSchema,
  RetrievalRequestSchema,
  RunStartResponseSchema,
  StartRunInputSchema,
} from "../src/contracts/runtime/index.ts"
import { isRunToken } from "../src/runtime/credentials.ts"

test("runtime contracts reject human credentials and half-item budgets", () => {
  // Given
  const humanToken = `afw_${"a".repeat(43)}`
  const runToken = `afwr_${"a".repeat(43)}`

  // When / Then
  assert.equal(isRunToken(humanToken), false)
  assert.equal(isRunToken(runToken), true)
  assert.equal(
    RetrievalRequestSchema.safeParse({
      operation: "search_entities",
      query: "work",
      kinds: ["work_item"],
      projection: "card",
      budget: { maxItems: 0, maxTokens: 100 },
    }).success,
    false,
  )
})

test("runtime public inputs are strict and generation-bound", () => {
  // Given
  const start = {
    installationId: "installation-1",
    subjectRef: "work_item:1",
    directiveRef: "directive:1",
    idempotencyKey: "start-1",
  }
  const activity = {
    generation: 2,
    idempotencyKey: "activity-1",
    kind: "observation",
    durable: true,
    body: { fact: "verified" },
    references: ["work_item:1"],
    rawTraceRefs: [],
  }

  // When / Then
  assert.equal(StartRunInputSchema.safeParse({ ...start, ownerId: "owner" }).success, false)
  assert.equal(ActivityInputSchema.safeParse(activity).success, true)
  assert.equal(ActivityInputSchema.safeParse({ ...activity, generation: 0 }).success, false)
})

test("run start never exposes a workspace credential", () => {
  // Given
  const response = {
    runId: "run-1",
    installationId: "installation-1",
    subjectRef: "work_item:1",
    directiveRef: "directive:1",
    bootstrapHandle: "bootstrap:run-1",
    callbackBaseUrl: "/api/runtime/v1/runs/run-1",
    runToken: `afwr_${"a".repeat(43)}`,
    leaseExpiresAt: "2026-10-17T12:00:00.000Z",
    protocolVersion: "runtime.v1",
    generation: 1,
  }

  // When
  const parsed = RunStartResponseSchema.parse(response)

  // Then
  assert.match(parsed.runToken, /^afwr_/)
  assert.equal("workspaceToken" in parsed, false)
})
