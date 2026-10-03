import assert from "node:assert/strict"
import { test } from "node:test"
import {
  ActorIdSchema,
  EventIdSchema,
  HumanPrincipalIdSchema,
  IdempotencyKeySchema,
  RawIdempotencyKeySchema,
  WorkItemIdSchema,
  WorkItemTitleSchema,
  WorkspaceIdSchema,
} from "../src/work-items/identifiers.ts"

const identifierSchemas = [
  WorkspaceIdSchema,
  WorkItemIdSchema,
  HumanPrincipalIdSchema,
  ActorIdSchema,
  EventIdSchema,
] as const

test("identifier raw bounds apply before trimming and output is normalized", () => {
  // Given
  const exact = ` ${"x".repeat(126)} `
  const tooLongAfterTrim = ` ${"x".repeat(127)} `

  // When / Then
  for (const schema of identifierSchemas) {
    assert.equal(schema.parse(exact), "x".repeat(126))
    assert.equal(schema.safeParse(tooLongAfterTrim).success, false)
    assert.equal(schema.safeParse("   ").success, false)
  }
})

test("title raw bounds apply before trimming", () => {
  // Given
  const exact = ` ${"x".repeat(198)} `
  const tooLongAfterTrim = ` ${"x".repeat(199)} `

  // When / Then
  assert.equal(WorkItemTitleSchema.parse(exact), "x".repeat(198))
  assert.equal(WorkItemTitleSchema.safeParse(tooLongAfterTrim).success, false)
  assert.equal(WorkItemTitleSchema.safeParse("   ").success, false)
})

test("idempotency keys are 1 to 200 visible ASCII characters without normalization", () => {
  // Given
  const schemas = [RawIdempotencyKeySchema, IdempotencyKeySchema] as const
  const invalidValues = ["", "has space", "\t", "\u0001", "😀", " key "] as const

  // When / Then
  for (const schema of schemas) {
    assert.equal(schema.parse("simple-key"), "simple-key")
    assert.equal(schema.parse("x".repeat(200)), "x".repeat(200))
    assert.equal(schema.safeParse("x".repeat(201)).success, false)
    for (const value of invalidValues) assert.equal(schema.safeParse(value).success, false)
  }
})

test("astral strings accepted by OpenAPI are accepted at runtime", () => {
  // Given
  const emoji = "😀"

  // When / Then
  assert.equal(WorkspaceIdSchema.parse(emoji.repeat(65)), emoji.repeat(65))
  assert.equal(WorkItemTitleSchema.parse(emoji.repeat(101)), emoji.repeat(101))
})

test("identifier limits count ASCII and astral Unicode code points", () => {
  // Given
  const emoji = "😀"

  // When / Then
  for (const schema of identifierSchemas) {
    assert.equal(schema.parse("x".repeat(128)), "x".repeat(128))
    assert.equal(schema.safeParse("x".repeat(129)).success, false)
    assert.equal(schema.parse(emoji.repeat(128)), emoji.repeat(128))
    assert.equal(schema.safeParse(emoji.repeat(129)).success, false)
  }
})

test("title limits count ASCII and astral Unicode code points", () => {
  // Given
  const emoji = "😀"

  // When / Then
  assert.equal(WorkItemTitleSchema.parse("x".repeat(200)), "x".repeat(200))
  assert.equal(WorkItemTitleSchema.safeParse("x".repeat(201)).success, false)
  assert.equal(WorkItemTitleSchema.parse(emoji.repeat(200)), emoji.repeat(200))
  assert.equal(WorkItemTitleSchema.safeParse(emoji.repeat(201)).success, false)
})
