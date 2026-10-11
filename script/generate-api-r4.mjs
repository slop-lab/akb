import { readFile, writeFile } from "node:fs/promises"
import { z } from "zod"
import {
  BoardRequestSchema,
  BoardSchema,
  BootstrapSchema,
  CommandEnvelopeSchema,
  CommandResultSchema,
  CommentSchema,
  ExportRequestSchema,
  HistoryEntrySchema,
  HumanWorkQuerySchema,
  ImportCommitSchema,
  ImportRecordSchema,
  ImportValidationSchema,
  ProjectPageSchema,
  ProjectQuerySchema,
  ProjectSchema,
  QueryPageSchema,
  RelationSchema,
  SavedViewSchema,
  SpaceConfigSchema,
  SpaceSchema,
  WorkItemDetailSchema,
} from "../src/contracts/r4/index.ts"
import { SearchPageSchema, SearchRequestPagedSchema } from "../src/contracts/r4/search.ts"
import { COMMAND_ROUTES } from "../src/http/command-v1/routes.ts"

const OUTPUT_PATH = new URL("../docs/openapi-r4.json", import.meta.url)

function jsonSchema(schema) {
  const { $schema: _dialect, ...document } = z.toJSONSchema(schema, { io: "input" })
  return document
}

function routePath(route) {
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

function pathParameters(path) {
  return [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: match[1] === "snapshotId" ? { type: "string", format: "uuid" } : { type: "string" },
  }))
}

function jsonBody(schema) {
  return { required: true, content: { "application/json": { schema: jsonSchema(schema) } } }
}

function response(description, schema, mediaType = "application/json") {
  return schema === undefined ? { description } : { description, content: { [mediaType]: { schema: jsonSchema(schema) } } }
}

function operation(path, options) {
  return {
    operationId: options.operationId,
    tags: [options.tag],
    parameters: [...pathParameters(path), ...(options.parameters ?? [])],
    ...(options.requestBody === undefined ? {} : { requestBody: options.requestBody }),
    responses: options.responses,
  }
}

function commandPaths() {
  const paths = {}
  for (const route of COMMAND_ROUTES) {
    const path = routePath(route)
    paths[path] ??= {}
    paths[path][route.method.toLowerCase()] = operation(path, {
      operationId: route.action.replaceAll(".", "-") + "-command",
      tag: "Commands",
      requestBody: jsonBody(CommandEnvelopeSchema.extend({ payload: route.payload })),
      responses: {
        [route.create ? "201" : "200"]: response("Command applied", CommandResultSchema),
        ...(route.create ? { 200: response("Idempotent replay", CommandResultSchema) } : {}),
        400: response("Invalid command"),
        403: response("Permission denied"),
        404: response("Resource not found or not disclosed"),
        409: response("Revision, idempotency, or invariant conflict"),
      },
    })
  }
  return paths
}

const getRoutes = [
  ["/api/human/v1/workspaces/{workspaceId}/bootstrap", "human-bootstrap", BootstrapSchema],
  ["/api/human/v1/workspaces/{workspaceId}/spaces", "list-readable-spaces", z.strictObject({ spaces: z.array(SpaceSchema) })],
  ["/api/human/v1/workspaces/{workspaceId}/spaces/{spaceId}/config", "read-space-config", SpaceConfigSchema],
  ["/api/human/v1/workspaces/{workspaceId}/projects/{projectId}", "read-project", ProjectSchema],
  ["/api/human/v1/workspaces/{workspaceId}/work-items/{workItemId}", "read-r4-work-item", WorkItemDetailSchema],
  ["/api/human/v1/workspaces/{workspaceId}/entities/{entityId}/history", "read-entity-history", z.array(HistoryEntrySchema)],
  ["/api/human/v1/workspaces/{workspaceId}/entities/{entityId}/relations", "read-entity-relations", z.array(RelationSchema)],
  ["/api/human/v1/workspaces/{workspaceId}/entities/{entityId}/comments", "read-entity-comments", z.array(CommentSchema)],
  ["/api/human/v1/workspaces/{workspaceId}/saved-views", "list-saved-views", z.strictObject({ views: z.array(SavedViewSchema) })],
]

const jsonRoutes = [
  ["/api/human/v1/workspaces/{workspaceId}/projects/query", "query-projects", ProjectQuerySchema, ProjectPageSchema],
  ["/api/human/v1/workspaces/{workspaceId}/work-items/query", "query-work-items", HumanWorkQuerySchema, QueryPageSchema],
  ["/api/human/v1/workspaces/{workspaceId}/work-items/board", "query-work-board", BoardRequestSchema, BoardSchema],
  ["/api/human/v1/workspaces/{workspaceId}/search", "search-r4", SearchRequestPagedSchema, SearchPageSchema],
]

function specialPaths(paths) {
  for (const [path, operationId, schema] of getRoutes) {
    paths[path] = {
      get: operation(path, {
        operationId,
        tag: "Human queries",
        responses: { 200: response("Authorized projection", schema), 404: response("Not found") },
      }),
    }
  }
  for (const [path, operationId, requestSchema, responseSchema] of jsonRoutes) {
    paths[path] = {
      post: operation(path, {
        operationId,
        tag: "Human queries",
        requestBody: jsonBody(requestSchema),
        responses: { 200: response("Stable query page", responseSchema) },
      }),
    }
  }
  const eventsPath = "/api/events/v1/workspaces/{workspaceId}/events"
  paths[eventsPath] = {
    get: operation(eventsPath, {
      operationId: "replay-entity-events",
      tag: "Events",
      parameters: [
        { name: "after", in: "query", schema: { type: "integer", minimum: 0 } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
      ],
      responses: { 200: response("Ordered entity event page") },
    }),
  }
  const snapshotPath = "/api/human/v1/workspaces/{workspaceId}/query-snapshots/{snapshotId}"
  paths[snapshotPath] = {
    delete: operation(snapshotPath, {
      operationId: "release-query-snapshot",
      tag: "Human queries",
      responses: { 204: response("Snapshot released or not disclosed") },
    }),
  }
  const exportPath = "/api/human/v1/workspaces/{workspaceId}/export"
  paths[exportPath] = {
    post: operation(exportPath, {
      operationId: "export-r4",
      tag: "Interchange",
      requestBody: jsonBody(ExportRequestSchema),
      responses: { 200: response("Authorized NDJSON export") },
    }),
  }
  const importPath = "/api/commands/v1/workspaces/{workspaceId}/imports"
  paths[importPath] = {
    post: operation(importPath, {
      operationId: "import-r4",
      tag: "Interchange",
      parameters: [
        {
          name: "mode",
          in: "query",
          required: true,
          schema: { type: "string", enum: ["validate", "commit"] },
        },
        {
          name: "command-id",
          in: "header",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "idempotency-key",
          in: "header",
          required: true,
          schema: { type: "string", minLength: 1, maxLength: 200, pattern: "^[!-~]+$" },
        },
        { name: "validation-token", in: "header", required: false, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/x-ndjson": {
            schema: { type: "string" },
            "x-record-schema": jsonSchema(ImportRecordSchema),
          },
        },
      },
      responses: {
        200: {
          description: "Validation or commit result",
          content: {
            "application/json": {
              schema: {
                oneOf: [jsonSchema(ImportValidationSchema), jsonSchema(ImportCommitSchema)],
              },
            },
          },
        },
        400: response("Invalid import"),
        409: response("Import conflict"),
      },
    }),
  }
  return paths
}

const document = {
  openapi: "3.1.0",
  info: {
    title: "Agent-First Workspace R3/R4 API",
    version: "0.1.0-r4-local",
    description: "Generated inventory for the locally implemented R3/R4 surface. It is not evidence that roadmap phase gates or CI have passed.",
  },
  security: [{ bearerAuth: [] }],
  paths: specialPaths(commandPaths()),
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
}

const content = `${JSON.stringify(document, null, 2)}\n`
if (process.argv.includes("--check")) {
  const current = await readFile(OUTPUT_PATH, "utf8").catch(() => "")
  if (current !== content) {
    process.stderr.write("docs/openapi-r4.json is not generated from the current R4 route schemas\n")
    process.exitCode = 1
  }
} else {
  await writeFile(OUTPUT_PATH, content)
}
