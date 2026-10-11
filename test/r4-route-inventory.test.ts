import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { z, type ZodType } from "zod"
import {
  BoardRequestSchema,
  ExportRequestSchema,
  HumanWorkQuerySchema,
  ProjectQuerySchema,
} from "../src/contracts/r4/index.ts"
import { CommandEnvelopeSchema } from "../src/contracts/r4/command.ts"
import { SearchRequestPagedSchema } from "../src/contracts/r4/search.ts"
import { COMMAND_ROUTES, type CommandRoute } from "../src/http/command-v1/routes.ts"

const JsonSchemaSchema = z
  .object({ additionalProperties: z.unknown().optional() })
  .catchall(z.unknown())
const OperationSchema = z.object({
  requestBody: z
    .object({ content: z.record(z.string(), z.object({ schema: JsonSchemaSchema })) })
    .optional(),
  responses: z.record(z.string(), z.object({ description: z.string() }).loose()),
})
const DocumentSchema = z.object({
  openapi: z.literal("3.1.0"),
  paths: z.record(z.string(), z.record(z.string(), OperationSchema)),
})

const JSON_ROUTES = [
  ["post", "/api/human/v1/workspaces/{workspaceId}/projects/query", ProjectQuerySchema],
  ["post", "/api/human/v1/workspaces/{workspaceId}/work-items/query", HumanWorkQuerySchema],
  ["post", "/api/human/v1/workspaces/{workspaceId}/work-items/board", BoardRequestSchema],
  ["post", "/api/human/v1/workspaces/{workspaceId}/search", SearchRequestPagedSchema],
  ["post", "/api/human/v1/workspaces/{workspaceId}/export", ExportRequestSchema],
] as const satisfies readonly (readonly [string, string, ZodType])[]

const SPECIAL_ROUTES = [
  ["get", "/api/events/v1/workspaces/{workspaceId}/events"],
  ["get", "/api/human/v1/workspaces/{workspaceId}/bootstrap"],
  ["get", "/api/human/v1/workspaces/{workspaceId}/spaces"],
  ["get", "/api/human/v1/workspaces/{workspaceId}/spaces/{spaceId}/config"],
  ["get", "/api/human/v1/workspaces/{workspaceId}/projects/{projectId}"],
  ["get", "/api/human/v1/workspaces/{workspaceId}/work-items/{workItemId}"],
  ["get", "/api/human/v1/workspaces/{workspaceId}/entities/{entityId}/history"],
  ["get", "/api/human/v1/workspaces/{workspaceId}/entities/{entityId}/relations"],
  ["get", "/api/human/v1/workspaces/{workspaceId}/entities/{entityId}/comments"],
  ["get", "/api/human/v1/workspaces/{workspaceId}/saved-views"],
  ["post", "/api/human/v1/workspaces/{workspaceId}/projects/query"],
  ["post", "/api/human/v1/workspaces/{workspaceId}/work-items/query"],
  ["post", "/api/human/v1/workspaces/{workspaceId}/work-items/board"],
  ["post", "/api/human/v1/workspaces/{workspaceId}/search"],
  ["delete", "/api/human/v1/workspaces/{workspaceId}/query-snapshots/{snapshotId}"],
  ["post", "/api/human/v1/workspaces/{workspaceId}/export"],
  ["post", "/api/commands/v1/workspaces/{workspaceId}/imports"],
] as const

function routePath(route: CommandRoute): string {
  let captureIndex = 0
  return route.pattern.source
    .replace(/^\^|\$$/gu, "")
    .replaceAll("\\/", "/")
    .replaceAll("([^/]+)", () => {
      captureIndex += 1
      if (captureIndex === 1) return "{workspaceId}"
      if (captureIndex === route.parentCapture) return "{parentId}"
      if (captureIndex === route.resourceCapture) return "{resourceId}"
      return `{pathId${captureIndex}}`
    })
}

function generatedSchema(schema: ZodType): Readonly<Record<string, unknown>> {
  const { $schema: _dialect, ...document } = z.toJSONSchema(schema, { io: "input" })
  return document
}

async function readDocument(): Promise<z.infer<typeof DocumentSchema>> {
  return DocumentSchema.parse(JSON.parse(await readFile("docs/openapi-r4.json", "utf8")))
}

function operation(
  document: z.infer<typeof DocumentSchema>,
  method: string,
  path: string,
): z.infer<typeof OperationSchema> {
  return OperationSchema.parse(document.paths[path]?.[method])
}

test("R4 OpenAPI command inventory is generated from every command route and payload schema", async () => {
  // Given
  const document = await readDocument()

  // When
  const documented = COMMAND_ROUTES.map((route) => {
    const routeOperation = operation(document, route.method.toLowerCase(), routePath(route))
    const schema = routeOperation.requestBody?.content["application/json"]?.schema
    return { route, schema }
  })

  // Then
  assert.equal(COMMAND_ROUTES.length, 27)
  for (const { route, schema } of documented) {
    assert.deepEqual(
      schema,
      generatedSchema(CommandEnvelopeSchema.extend({ payload: route.payload })),
      route.action,
    )
  }
})

test("R4 OpenAPI documents the complete special route inventory and actual JSON schemas", async () => {
  // Given
  const document = await readDocument()

  // When
  const specialOperations = SPECIAL_ROUTES.map(([method, path]) =>
    operation(document, method, path),
  )
  const operationCount = Object.values(document.paths).reduce(
    (count, pathItem) => count + Object.keys(pathItem).length,
    0,
  )

  // Then
  assert.equal(specialOperations.length, 17)
  assert.equal(operationCount, COMMAND_ROUTES.length + SPECIAL_ROUTES.length)
  for (const [method, path, schema] of JSON_ROUTES) {
    assert.deepEqual(
      operation(document, method, path).requestBody?.content["application/json"]?.schema,
      generatedSchema(schema),
      path,
    )
  }
  assert.deepEqual(
    operation(
      document,
      "delete",
      "/api/human/v1/workspaces/{workspaceId}/query-snapshots/{snapshotId}",
    ).responses["204"],
    { description: "Snapshot released or not disclosed" },
  )
})

test("R4 command envelopes are strict and never accept an outer or payload actor", async () => {
  // Given
  const document = await readDocument()

  // When
  const schemas = COMMAND_ROUTES.map(
    (route) =>
      operation(document, route.method.toLowerCase(), routePath(route)).requestBody?.content[
        "application/json"
      ]?.schema,
  )

  // Then
  for (const schema of schemas) {
    assert.equal(JSON.stringify(schema).includes('"actorId"'), false)
    assert.equal(schema?.additionalProperties, false)
  }
})

test("R4 OpenAPI generation is reproducible and preserves the legacy OpenAPI bytes", async () => {
  // Given
  const legacy = await readFile("docs/openapi.json")

  // When
  const generated = spawnSync(process.execPath, ["script/generate-api-r4.mjs", "--check"], {
    encoding: "utf8",
  })
  const legacyDigest = createHash("sha256").update(legacy).digest("hex")

  // Then
  assert.equal(generated.status, 0, generated.stderr || generated.stdout)
  assert.equal(legacyDigest, "94d1d9ab73ce427a8821f02150749a86a3aa748fbec899cd634f5ddab7da0646")
})
