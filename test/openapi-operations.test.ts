import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { z } from "zod"

const ReferenceSchema = z.strictObject({ $ref: z.string() })
const RequestBodySchema = z.strictObject({
  required: z.literal(true),
  content: z.strictObject({
    "application/json": z.strictObject({ schema: ReferenceSchema }),
  }),
})
const OperationSchema = z.object({
  parameters: z.array(ReferenceSchema).optional(),
  requestBody: RequestBodySchema.optional(),
  responses: z.record(z.string(), ReferenceSchema),
})
const DocumentSchema = z.object({
  paths: z.record(
    z.string(),
    z.object({
      get: OperationSchema.optional(),
      post: OperationSchema.optional(),
      patch: OperationSchema.optional(),
    }),
  ),
  components: z.object({
    responses: z.object({ Health: z.unknown(), WorkItemList: z.unknown() }).catchall(z.unknown()),
  }),
})

const operationContracts = [
  {
    path: "/health",
    method: "get",
    parameters: [],
    requestBody: undefined,
    responses: { "200": "Health" },
  },
  {
    path: "/api/workspaces/{workspaceId}/work-items",
    method: "get",
    parameters: ["WorkspaceId"],
    requestBody: undefined,
    responses: {
      "200": "WorkItemList",
      "400": "InvalidArgument",
      "401": "Unauthenticated",
      "403": "PermissionDenied",
      "404": "WorkspaceNotFound",
      "500": "Internal",
    },
  },
  {
    path: "/api/workspaces/{workspaceId}/work-items",
    method: "post",
    parameters: ["WorkspaceId", "IdempotencyKey"],
    requestBody: "CreateWorkItem",
    responses: {
      "201": "WorkItem",
      "400": "InvalidArgument",
      "401": "Unauthenticated",
      "403": "PermissionDenied",
      "404": "WorkspaceNotFound",
      "409": "IdempotencyConflict",
      "413": "BodyBudgetExceeded",
      "500": "Internal",
      "507": "CapacityExceeded",
    },
  },
  {
    path: "/api/work-items/{id}",
    method: "get",
    parameters: ["WorkItemId"],
    requestBody: undefined,
    responses: {
      "200": "WorkItem",
      "400": "InvalidArgument",
      "401": "Unauthenticated",
      "404": "WorkItemNotFound",
      "500": "Internal",
    },
  },
  {
    path: "/api/work-items/{id}",
    method: "patch",
    parameters: ["WorkItemId"],
    requestBody: "PatchWorkItem",
    responses: {
      "200": "WorkItem",
      "400": "InvalidArgument",
      "401": "Unauthenticated",
      "403": "PermissionDenied",
      "404": "WorkItemNotFound",
      "409": "RevisionConflict",
      "413": "BodyBudgetExceeded",
      "500": "Internal",
      "507": "CapacityExceeded",
    },
  },
] as const

test("every operation binds exact parameter, body, and response components", async () => {
  // Given
  const document = DocumentSchema.parse(JSON.parse(await readFile("docs/openapi.json", "utf8")))

  // When / Then
  for (const contract of operationContracts) {
    const operation = document.paths[contract.path]?.[contract.method]
    assert.ok(operation)
    assert.deepEqual(
      operation.parameters?.map((parameter) => parameter.$ref) ?? [],
      contract.parameters.map((name) => `#/components/parameters/${name}`),
    )
    assert.equal(
      operation.requestBody?.content["application/json"].schema.$ref,
      contract.requestBody === undefined
        ? undefined
        : `#/components/schemas/${contract.requestBody}`,
    )
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(operation.responses).map(([status, reference]) => [status, reference.$ref]),
      ),
      Object.fromEntries(
        Object.entries(contract.responses).map(([status, name]) => [
          status,
          `#/components/responses/${name}`,
        ]),
      ),
    )
  }
})

test("every response component binds its exact schema", async () => {
  // Given
  const document = DocumentSchema.parse(JSON.parse(await readFile("docs/openapi.json", "utf8")))
  const ResponseSchema = z.object({
    content: z.object({ "application/json": z.object({ schema: ReferenceSchema }) }),
  })
  const responseSchemas = {
    Health: "#/components/schemas/HealthResponse",
    WorkItemList: "#/components/schemas/WorkItemList",
    WorkItem: "#/components/schemas/WorkItemEnvelope",
    Unauthenticated: "#/components/schemas/AccessError",
    PermissionDenied: "#/components/schemas/AccessError",
    WorkspaceNotFound: "#/components/schemas/AccessError",
    InvalidArgument: "#/components/schemas/InvalidArgumentError",
    WorkItemNotFound: "#/components/schemas/WorkItemNotFoundError",
    RouteNotFound: "#/components/schemas/RouteNotFoundError",
    IdempotencyConflict: "#/components/schemas/IdempotencyConflictError",
    RevisionConflict: "#/components/schemas/RevisionConflictError",
    BodyBudgetExceeded: "#/components/schemas/BodyBudgetExceededError",
    CapacityExceeded: "#/components/schemas/CapacityExceededError",
    Internal: "#/components/schemas/InternalError",
  } as const

  // When / Then
  assert.deepEqual(
    Object.keys(document.components.responses).sort(),
    Object.keys(responseSchemas).sort(),
  )
  for (const [name, schemaRef] of Object.entries(responseSchemas)) {
    const response = ResponseSchema.parse(document.components.responses[name])
    assert.equal(response.content["application/json"].schema.$ref, schemaRef)
  }
})
