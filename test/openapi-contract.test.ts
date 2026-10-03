import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { z, type ZodType } from "zod"
import {
  RawActorIdSchema,
  RawIdempotencyKeySchema,
  RawWorkItemIdSchema,
  RawWorkItemTitleSchema,
  RawWorkspaceIdSchema,
} from "../src/work-items/identifiers.ts"
import {
  BodyBudgetExceededErrorSchema,
  CapacityExceededErrorSchema,
  FieldErrorSchema,
  IdempotencyConflictErrorSchema,
  InternalErrorSchema,
  InvalidArgumentErrorSchema,
  RevisionConflictErrorSchema,
  RouteNotFoundErrorSchema,
  WorkItemNotFoundErrorSchema,
} from "../src/http/error-schemas.ts"
import {
  RawCreateWorkItemBodySchema,
  RawPatchWorkItemBodySchema,
  RawWorkItemPathSchema,
  RawWorkspacePathSchema,
} from "../src/http/schemas.ts"
import { RawPathSegmentSchema } from "../src/http/path-segment.ts"
import {
  HealthResponseSchema,
  ListCompletenessSchema,
  ListOmissionSchema,
  WorkItemCardSchema,
  WorkItemEnvelopeSchema,
  WorkItemListSchema,
  WorkItemSchema,
} from "../src/http/work-item-response-schemas.ts"

const JsonSchemaSchema = z.record(z.string(), z.unknown())
const ParameterSchema = z.object({ schema: JsonSchemaSchema })
const PathParameterSchema = z.object({
  allOf: z.tuple([
    z.object({ type: z.literal("string"), pattern: z.string() }).loose(),
    JsonSchemaSchema,
  ]),
})
const DocumentSchema = z.object({
  components: z.object({
    parameters: z.object({ IdempotencyKey: ParameterSchema }).catchall(ParameterSchema),
    schemas: z.object({ PatchWorkItem: JsonSchemaSchema }).catchall(JsonSchemaSchema),
    responses: z.record(z.string(), z.unknown()),
  }),
})

const componentSchemas = {
  HealthResponse: HealthResponseSchema,
  CreateWorkItem: RawCreateWorkItemBodySchema,
  PatchWorkItem: RawPatchWorkItemBodySchema,
  WorkItem: WorkItemSchema,
  WorkItemEnvelope: WorkItemEnvelopeSchema,
  WorkItemCard: WorkItemCardSchema,
  ListCompleteness: ListCompletenessSchema,
  ListOmission: ListOmissionSchema,
  WorkItemList: WorkItemListSchema,
  FieldError: FieldErrorSchema,
  InvalidArgumentError: InvalidArgumentErrorSchema,
  WorkItemNotFoundError: WorkItemNotFoundErrorSchema,
  RouteNotFoundError: RouteNotFoundErrorSchema,
  IdempotencyConflictError: IdempotencyConflictErrorSchema,
  RevisionConflictError: RevisionConflictErrorSchema,
  BodyBudgetExceededError: BodyBudgetExceededErrorSchema,
  CapacityExceededError: CapacityExceededErrorSchema,
  InternalError: InternalErrorSchema,
} satisfies Readonly<Record<string, ZodType>>

function toComponent(schema: ZodType): Readonly<Record<string, unknown>> {
  const { $schema: _dialect, ...component } = z.toJSONSchema(schema, { io: "input" })
  return component
}

async function readDocument(): Promise<z.infer<typeof DocumentSchema>> {
  return DocumentSchema.parse(JSON.parse(await readFile("docs/openapi.json", "utf8")))
}

test("OpenAPI components equal Zod input schemas where representable", async () => {
  // Given
  const document = await readDocument()

  // When
  const generated = Object.fromEntries(
    Object.entries(componentSchemas).map(([name, schema]) => [name, toComponent(schema)]),
  )

  // Then
  for (const [name, schema] of Object.entries(generated)) {
    if (name === "PatchWorkItem") {
      const { anyOf: _patchRequirement, ...representable } = document.components.schemas[name] ?? {}
      assert.deepEqual(representable, schema)
    } else {
      assert.deepEqual(document.components.schemas[name], schema)
    }
  }
  const { anyOf } = document.components.schemas.PatchWorkItem
  assert.deepEqual(anyOf, [{ required: ["title"] }, { required: ["state"] }])
})

test("raw semantic input schemas expose whitespace and length constraints", () => {
  // Given
  const schemas = [
    { schema: RawWorkspaceIdSchema, maxLength: 128 },
    { schema: RawWorkItemIdSchema, maxLength: 128 },
    { schema: RawActorIdSchema, maxLength: 128 },
    { schema: RawWorkItemTitleSchema, maxLength: 200 },
  ] as const

  // When
  const generated = schemas.map(({ schema, maxLength }) => ({
    jsonSchema: toComponent(schema),
    maxLength,
  }))

  // Then
  for (const { jsonSchema, maxLength } of generated) {
    const { maxLength: generatedMaxLength, minLength, pattern } = jsonSchema
    assert.equal(minLength, 1)
    assert.equal(generatedMaxLength, maxLength)
    assert.equal(pattern, "\\S")
  }
})

test("OpenAPI Idempotency-Key parameter preserves the shared visible ASCII schema", async () => {
  // Given
  const document = await readDocument()

  // When
  const generated = toComponent(RawIdempotencyKeySchema)

  // Then
  assert.deepEqual(generated, {
    type: "string",
    minLength: 1,
    maxLength: 200,
    pattern: "^[!-~]+$",
  })
  assert.deepEqual(document.components.parameters.IdempotencyKey.schema, generated)
})

test("OpenAPI parameters equal the shared semantic input schemas", async () => {
  // Given
  const document = await readDocument()
  const parameters = {
    WorkspaceId: RawWorkspacePathSchema,
    WorkItemId: RawWorkItemPathSchema,
    IdempotencyKey: RawIdempotencyKeySchema,
  } satisfies Readonly<Record<string, ZodType>>

  // When
  const generated = Object.fromEntries(
    Object.entries(parameters).map(([name, schema]) => [name, toComponent(schema)]),
  )

  // Then
  for (const [name, schema] of Object.entries(generated)) {
    assert.deepEqual(document.components.parameters[name]?.schema, schema)
  }
})

test("OpenAPI path parameters reject decoded separators", async () => {
  // Given
  const document = await readDocument()

  // When / Then
  for (const separator of ["/", "\\"]) {
    assert.equal(RawPathSegmentSchema.safeParse(separator).success, false)
    assert.equal(RawWorkspacePathSchema.safeParse(separator).success, false)
    assert.equal(RawWorkItemPathSchema.safeParse(separator).success, false)
  }
  for (const name of ["WorkspaceId", "WorkItemId"] as const) {
    const parameter = PathParameterSchema.parse(document.components.parameters[name]?.schema)
    const pathPattern = new RegExp(parameter.allOf[0].pattern, "u")
    assert.equal(pathPattern.test("safe-id"), true)
    assert.equal(pathPattern.test("/"), false)
    assert.equal(pathPattern.test("\\"), false)
  }
})
