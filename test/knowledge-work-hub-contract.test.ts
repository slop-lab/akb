import assert from "node:assert/strict"
import { test } from "node:test"
import { ProposalSourceSchema } from "../src/contracts/knowledge/index.ts"

test("external Work Hub provenance has an immutable typed version and safe permalink", () => {
  // Given
  const source = {
    kind: "external",
    serviceInstanceId: "work-hub:local",
    resourceKind: "result",
    resourceId: "result-42",
    version: { kind: "digest", algorithm: "sha256", value: "a".repeat(64) },
    permalink: "https://work-hub.example.test/results/result-42",
    excerpt: "Connector tests passed.",
    role: "supporting",
  }

  // When
  const parsed = ProposalSourceSchema.safeParse(source)

  // Then
  assert.equal(parsed.success, true)
})

test("external provenance rejects credential-bearing permalinks", () => {
  // Given
  const source = {
    kind: "external",
    serviceInstanceId: "work-hub:local",
    resourceKind: "task",
    resourceId: "task-42",
    version: { kind: "revision", value: "17" },
    permalink: "https://token@example.test/tasks/task-42",
    role: "context",
  }

  // When
  const parsed = ProposalSourceSchema.safeParse(source)

  // Then
  assert.equal(parsed.success, false)
})
