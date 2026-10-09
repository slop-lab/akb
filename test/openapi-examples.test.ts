import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { z } from "zod"
import { MAX_JSON_BODY_BYTES } from "../src/http/request-body.ts"
import type { WorkItemStore } from "../src/work-items/store.ts"
import {
  jsonRequest,
  startHttpFixture,
  startHttpFixtureWithStore,
  VALID_CREATE_BODY,
} from "./http-fixture.ts"

const ExampleSchema = z.strictObject({ value: z.unknown() })
const ResponseSchema = z.object({
  content: z.object({
    "application/json": z.object({ examples: z.record(z.string(), ExampleSchema) }),
  }),
})
const DocumentSchema = z.object({
  components: z.object({
    responses: z.object({
      InvalidArgument: ResponseSchema,
      WorkItemNotFound: ResponseSchema,
      RouteNotFound: ResponseSchema,
      IdempotencyConflict: ResponseSchema,
      RevisionConflict: ResponseSchema,
      BodyBudgetExceeded: ResponseSchema,
      CapacityExceeded: ResponseSchema,
      Internal: ResponseSchema,
    }),
  }),
})
type Document = z.infer<typeof DocumentSchema>
type ResponseName = keyof Document["components"]["responses"]

async function readDocument(): Promise<Document> {
  return DocumentSchema.parse(JSON.parse(await readFile("docs/openapi.json", "utf8")))
}

function example(document: Document, responseName: ResponseName, exampleName: string): unknown {
  return document.components.responses[responseName].content["application/json"].examples[
    exampleName
  ]?.value
}

test("documented request and conflict examples equal observed HTTP envelopes", async (context) => {
  // Given
  const document = await readDocument()
  const fixture = await startHttpFixture()
  context.after(fixture.close)
  const created = await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest(VALID_CREATE_BODY, "example-create"),
  )
  assert.equal(created.status, 201)
  const updated = await fixture.request("/api/work-items/work-item-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: "actor-1", baseRevision: 1, title: "Updated" }),
  })
  assert.equal(updated.status, 200)
  const oversized = `"${"x".repeat(MAX_JSON_BODY_BYTES - 1)}"`

  // When
  const responses = await Promise.all([
    fixture.request(
      "/api/workspaces/workspace-1/work-items",
      jsonRequest({ ...VALID_CREATE_BODY, title: "   " }, "invalid-example"),
    ),
    fixture.request("/api/work-items/missing"),
    fixture.request("/missing-route"),
    fixture.request(
      "/api/workspaces/workspace-1/work-items",
      jsonRequest({ ...VALID_CREATE_BODY, title: "Different" }, "example-create"),
    ),
    fixture.request("/api/work-items/work-item-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId: "actor-1", baseRevision: 1, title: "Stale" }),
    }),
    fixture.request("/api/workspaces/workspace-1/work-items", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "large-example" },
      body: oversized,
    }),
  ])
  const observed = await Promise.all(responses.map((response) => response.json()))

  // Then
  assert.deepEqual(
    responses.map((response) => response.status),
    [400, 404, 404, 409, 409, 413],
  )
  const documented = [
    example(document, "InvalidArgument", "invalidArgument"),
    example(document, "WorkItemNotFound", "workItemNotFound"),
    example(document, "RouteNotFound", "routeNotFound"),
    example(document, "IdempotencyConflict", "idempotencyConflict"),
    example(document, "RevisionConflict", "revisionConflict"),
    example(document, "BodyBudgetExceeded", "bodyBudgetExceeded"),
  ]
  assert.deepEqual(observed, documented)
})

test("documented capacity examples equal observed HTTP envelopes", async (context) => {
  // Given
  const document = await readDocument()
  const itemFixture = await startHttpFixture({ itemCapacity: 0, auditRecordCapacity: 1 })
  const auditFixture = await startHttpFixture({ itemCapacity: 1, auditRecordCapacity: 1 })
  context.after(itemFixture.close)
  context.after(auditFixture.close)
  const created = await auditFixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest(VALID_CREATE_BODY, "audit-example"),
  )
  assert.equal(created.status, 201)

  // When
  const responses = await Promise.all([
    itemFixture.request(
      "/api/workspaces/workspace-1/work-items",
      jsonRequest(VALID_CREATE_BODY, "item-example"),
    ),
    auditFixture.request("/api/work-items/work-item-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId: "actor-1", baseRevision: 1, title: "Changed" }),
    }),
  ])
  const observed = await Promise.all(responses.map((response) => response.json()))

  // Then
  assert.deepEqual(
    responses.map((response) => response.status),
    [507, 507],
  )
  assert.deepEqual(observed, [
    example(document, "CapacityExceeded", "itemCapacity"),
    example(document, "CapacityExceeded", "auditCapacity"),
  ])
})

test("documented internal example equals an observed HTTP envelope", async (context) => {
  // Given
  const document = await readDocument()
  const store: WorkItemStore = {
    create: () => {
      throw new Error("adapter failed")
    },
    patch: (command) => ({ kind: "not_found", id: command.id }),
    get: () => undefined,
    list: () => ({ items: [], matched: 0 }),
  }
  const fixture = await startHttpFixtureWithStore(store)
  context.after(fixture.close)

  // When
  const response = await fixture.request(
    "/api/workspaces/workspace-1/work-items",
    jsonRequest(VALID_CREATE_BODY, "internal-example"),
  )

  // Then
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), example(document, "Internal", "internal"))
})
