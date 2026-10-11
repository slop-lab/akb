import assert from "node:assert/strict"
import { test } from "node:test"
import {
  BoardRequestSchema,
  BoardSchema,
  CommandEnvelopeSchema,
  FilterNodeSchema,
  HumanWorkQuerySchema,
  WorkItemDetailSchema,
} from "../src/contracts/r4/index.ts"

test("R4 command envelopes reject actors and unknown fields", () => {
  // Given
  const input = {
    commandId: "command-1",
    idempotencyKey: "key-1",
    baseRevision: null,
    payload: { name: "Example" },
    actorId: "forged",
  }

  // When
  const result = CommandEnvelopeSchema.safeParse(input)

  // Then
  assert.equal(result.success, false)
})

test("R4 filters enforce depth and node budgets", () => {
  // Given
  let filter: unknown = { op: "eq", field: "priority", value: "high" }
  for (let depth = 0; depth < 6; depth += 1) filter = { op: "not", filter }

  // When
  const result = FilterNodeSchema.safeParse(filter)

  // Then
  assert.equal(result.success, false)
})

test("R4 queries require stable bounded pagination and explicit nulls", () => {
  // Given
  const query = {
    model: "r4",
    filter: null,
    search: null,
    sort: [{ field: "updatedAt", direction: "desc" }],
    includeArchived: false,
    page: { size: 100, cursor: null },
  }

  // When
  const parsed = HumanWorkQuerySchema.parse(query)

  // Then
  assert.deepEqual(parsed, query)
  assert.equal(
    WorkItemDetailSchema.safeParse({ id: "missing-required-explicit-null-fields" }).success,
    false,
  )
})

test("board contracts bind continuation cursors to exactly one workflow state", () => {
  // Given
  const initial = {
    model: "r4",
    filter: null,
    search: null,
    sort: [{ field: "updatedAt", direction: "desc" }],
    includeArchived: false,
    workflowStateId: null,
    page: { size: 25, cursor: null },
  }

  // When
  const parsed = BoardRequestSchema.parse(initial)

  // Then
  assert.deepEqual(parsed, initial)
  assert.equal(
    BoardRequestSchema.safeParse({
      ...initial,
      workflowStateId: "state-1",
      page: { size: 25, cursor: null },
    }).success,
    false,
  )
  assert.equal(
    BoardSchema.safeParse({
      snapshot: {
        id: "11111111-1111-4111-8111-111111111111",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
      columns: [
        {
          state: {
            id: "state-1",
            revision: 1,
            name: "Started",
            category: "started",
            color: "#00f",
            position: 2,
            isDefault: false,
          },
          total: 26,
          cards: [],
          nextCursor: "signed",
        },
      ],
    }).success,
    true,
  )
})
