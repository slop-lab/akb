import assert from "node:assert/strict"
import { test } from "node:test"
import {
  BoardRequestSchema,
  BoardSchema,
  CommandEnvelopeSchema,
  FilterNodeSchema,
  type HumanWorkQuery,
  HumanWorkQuerySchema,
  type ImportRecord,
  WorkItemDetailSchema,
} from "../src/contracts/r4/index.ts"
import { normalizeSavedViewDefinition } from "../src/import-export/saved-view-transfer.ts"

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

test("R4 filters preserve string ranges for entity references", () => {
  // Given
  const fields = ["spaceId", "projectId", "workflowStateId", "labelId"] as const

  // When
  const results = fields.map((field) =>
    FilterNodeSchema.safeParse({ op: "range", field, from: "a", to: "z" }),
  )

  // Then
  assert.equal(
    results.every((result) => result.success),
    true,
  )
  assert.equal(
    FilterNodeSchema.safeParse({
      op: "range",
      field: "dueDate",
      from: "2026-01-01",
      to: "2026-12-31",
    }).success,
    true,
  )
  assert.equal(
    FilterNodeSchema.safeParse({ op: "range", field: "projectId", from: 1, to: 2 }).success,
    false,
  )
})

test("Saved View transfer normalizes broad typed ranges without cross-kind aliasing", () => {
  const records: readonly ImportRecord[] = [
    { kind: "space", externalId: "shared", key: "SH", name: "Shared" },
    projectRecord("project-a"),
  ]
  const definition = query({
    op: "and",
    filters: [
      { op: "range", field: "spaceId", from: "a", to: "z" },
      { op: "range", field: "projectId", from: "a", to: "z" },
    ],
  })

  const normalized = normalizeSavedViewDefinition(definition, records)

  assert.equal(normalized.kind, "normalized")
  if (normalized.kind !== "normalized") return
  assert.deepEqual(normalized.definition.filter, {
    op: "and",
    filters: [
      { op: "in", field: "spaceId", values: ["shared"] },
      { op: "in", field: "projectId", values: ["project-a"] },
    ],
  })
  assert.deepEqual(normalized.references, [
    { kind: "space", id: "shared" },
    { kind: "project", id: "project-a" },
  ])
  assert.equal(normalized.matchedRange, true)
})

test("Saved View transfer does not satisfy project references with colliding Space local IDs", () => {
  const records: readonly ImportRecord[] = [
    { kind: "space", externalId: "shared", key: "SH", name: "Shared" },
  ]

  const normalized = normalizeSavedViewDefinition(
    query({ op: "eq", field: "projectId", value: "shared" }),
    records,
  )

  assert.deepEqual(normalized, { kind: "unresolved_reference" })
})

test("Saved View transfer preserves nullable SQL unknown for an empty project range", () => {
  // Given
  const definition = query({ op: "range", field: "projectId", from: "z", to: "zz" })

  // When
  const normalized = normalizeSavedViewDefinition(definition, [projectRecord("project-a")])

  // Then
  assert.equal(normalized.kind, "normalized")
  if (normalized.kind !== "normalized") return
  assert.deepEqual(normalized.definition.filter, {
    op: "and",
    filters: [
      { op: "eq", field: "projectId", value: "project-a" },
      { op: "not", filter: { op: "eq", field: "projectId", value: "project-a" } },
    ],
  })
  assert.deepEqual(normalized.references, [{ kind: "project", id: "project-a" }])
})

test("Saved View transfer retains an empty project range when no Project can be remapped", () => {
  // Given
  const definition = query({ op: "range", field: "projectId", from: "z", to: "zz" })

  // When
  const normalized = normalizeSavedViewDefinition(definition, [])

  // Then
  assert.equal(normalized.kind, "normalized")
  if (normalized.kind !== "normalized") return
  assert.deepEqual(normalized.definition, definition)
  assert.equal(normalized.matchedRange, true)
})

test("Saved View transfer retains an unbounded reference range as scalar true", () => {
  // Given
  const definition = query({ op: "range", field: "projectId", from: null, to: null })

  // When
  const normalized = normalizeSavedViewDefinition(definition, [projectRecord("project-a")])

  // Then
  assert.equal(normalized.kind, "normalized")
  if (normalized.kind !== "normalized") return
  assert.deepEqual(normalized.definition, definition)
  assert.deepEqual(normalized.references, [])
})

test("Saved View transfer reports a typed budget result for oversized range expansion", () => {
  const records = Array.from({ length: 51 }, (_, index) =>
    projectRecord(`project-${index.toString().padStart(2, "0")}`),
  )

  const normalized = normalizeSavedViewDefinition(
    query({ op: "range", field: "projectId", from: "project-00", to: "project-99" }),
    records,
  )

  assert.deepEqual(normalized, { kind: "budget_exceeded" })
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

function query(filter: HumanWorkQuery["filter"]): HumanWorkQuery {
  return {
    model: "r4",
    filter,
    search: null,
    sort: [{ field: "updatedAt", direction: "desc" }],
    includeArchived: false,
    page: { size: 50, cursor: null },
  }
}

function projectRecord(id: string): ImportRecord {
  return {
    kind: "project",
    externalId: id,
    name: id,
    slug: id,
    ownerId: "owner",
    participatingSpaceIds: ["shared"],
  }
}
