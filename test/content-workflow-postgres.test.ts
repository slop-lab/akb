import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { z } from "zod"
import {
  ContentDocumentDiscoveryResponseSchema,
  ContextReadResponseSchema,
} from "../src/contracts/content/index.ts"
import { ContentWorkflowPostgresFixture, document } from "./content-workflow-postgres-fixture.ts"

const TemplateResponseSchema = z.strictObject({
  templates: z.array(
    z.strictObject({
      id: z.enum(["blank", "common-guidance", "feature-brief", "decision-record"]),
      name: z.string(),
      description: z.string(),
      document: z.object({ version: z.literal(1), blocks: z.array(z.unknown()) }),
    }),
  ),
})

let fixture: ContentWorkflowPostgresFixture

before(async () => {
  fixture = await ContentWorkflowPostgresFixture.create()
})

after(async () => fixture.close())

test("templates endpoint returns the frozen ordinary Page templates", async () => {
  // Given / When
  const response = await fixture.get(
    "/api/content/v1/workspaces/workspace/templates",
    fixture.hub.ownerToken,
  )

  // Then
  assert.equal(response.status, 200, response.body)
  assert.deepEqual(
    TemplateResponseSchema.parse(JSON.parse(response.body)).templates.map(
      (template) => template.id,
    ),
    ["blank", "common-guidance", "feature-brief", "decision-record"],
  )
})

test("document discovery applies ACL before its keyset limit", async () => {
  // Given / When
  const response = await fixture.get(
    "/api/content/v1/workspaces/workspace/documents?kind=page&query=ACL%20target&limit=1",
    fixture.contentReaderToken,
  )

  // Then
  assert.equal(response.status, 200, response.body)
  assert.deepEqual(ContentDocumentDiscoveryResponseSchema.parse(JSON.parse(response.body)), {
    items: [
      {
        kind: "page",
        id: "b-acl-visible",
        title: "ACL target",
        revision: 1,
        lifecycle: "active",
      },
    ],
    nextAfterId: null,
    consistency: "live",
  })
})

test("document discovery returns active title summaries with keyset continuation", async () => {
  // Given
  await fixture.createPage({
    id: "c-discovery",
    title: "Discoverable page",
    document: document("body"),
  })
  await fixture.createPage({
    id: "d-discovery",
    title: "Discoverable second",
    document: document("body"),
  })

  // When
  const first = await fixture.get(
    "/api/content/v1/workspaces/workspace/documents?kind=page&query=Discoverable&limit=1",
    fixture.hub.ownerToken,
  )

  // Then
  const firstPage = ContentDocumentDiscoveryResponseSchema.parse(JSON.parse(first.body))
  assert.equal(first.status, 200, first.body)
  assert.equal(first.headers["cache-control"], "no-store")
  assert.deepEqual(
    firstPage.items.map((item) => item.id),
    ["c-discovery"],
  )
  assert.equal(firstPage.nextAfterId, "c-discovery")
  const second = await fixture.get(
    `/api/content/v1/workspaces/workspace/documents?kind=page&query=Discoverable&limit=1&afterId=${firstPage.nextAfterId}`,
    fixture.hub.ownerToken,
  )
  assert.deepEqual(
    ContentDocumentDiscoveryResponseSchema.parse(JSON.parse(second.body)).items.map(
      (item) => item.id,
    ),
    ["d-discovery"],
  )
})

test("document discovery returns authorized Knowledge title summaries", async () => {
  // Given / When
  const response = await fixture.get(
    "/api/content/v1/workspaces/workspace/documents?kind=knowledge&query=Visible",
    fixture.hub.ownerToken,
  )

  // Then
  assert.equal(response.status, 200, response.body)
  const body = ContentDocumentDiscoveryResponseSchema.parse(JSON.parse(response.body))
  assert.deepEqual(
    body.items.map((item) => item.id),
    ["knowledge-visible"],
  )
})

test("explicit context returns immutable generic revision snapshots after archival", async () => {
  // Given / When
  const response = await fixture.context(fixture.hub.ownerToken, {
    references: [
      { kind: "page", id: "b-visible", revision: 1 },
      { kind: "knowledge", id: "knowledge-visible", revision: 1 },
    ],
  })

  // Then
  assert.equal(response.status, 200, response.body)
  assert.equal(response.headers["cache-control"], "no-store")
  const body = ContextReadResponseSchema.parse(JSON.parse(response.body))
  assert.equal(body.items[0]?.schemaVersion, "page.content.v1")
  const pageSnapshot = body.items[0]?.snapshot
  assert.ok(pageSnapshot)
  assert.equal(Reflect.get(pageSnapshot, "lifecycle"), "active")
  assert.equal(Reflect.get(pageSnapshot, "revision"), 1)
  assert.equal(body.items[1]?.schemaVersion, "knowledge-object.r7.v1")
  assert.equal(body.selectionPage, null)
})

test("selection Page context resolves only its exact saved manifest", async () => {
  // Given / When
  const response = await fixture.context(fixture.hub.ownerToken, {
    selectionPage: { id: "selection-valid", revision: 1 },
  })

  // Then
  assert.equal(response.status, 200, response.body)
  const body = ContextReadResponseSchema.parse(JSON.parse(response.body))
  assert.deepEqual(body.selectionPage, { id: "selection-valid", revision: 1 })
  assert.deepEqual(body.references, [
    { kind: "page", id: "b-visible", revision: 1 },
    { kind: "knowledge", id: "knowledge-visible", revision: 1 },
  ])
})

test("context hides unauthorized references with a generic not found", async () => {
  // Given / When
  const response = await fixture.context(fixture.contentReaderToken, {
    references: [{ kind: "knowledge", id: "knowledge-visible", revision: 1 }],
  })

  // Then
  assert.equal(response.status, 404, response.body)
  assert.equal(
    z.object({ error: z.object({ code: z.string() }) }).parse(JSON.parse(response.body)).error.code,
    "not_found",
  )
})

test("context rejects missing revisions without substituting latest", async () => {
  // Given / When
  const response = await fixture.context(fixture.hub.ownerToken, {
    references: [{ kind: "page", id: "b-visible", revision: 999 }],
  })

  // Then
  assert.equal(response.status, 404, response.body)
})

test("context rejects malformed, duplicate, and wrong-workspace saved selections", async () => {
  for (const id of ["selection-malformed", "selection-duplicate", "selection-wrong-workspace"]) {
    // Given / When
    const response = await fixture.context(fixture.hub.ownerToken, {
      selectionPage: { id, revision: 1 },
    })

    // Then
    assert.equal(response.status, 422, `${id}: ${response.body}`)
    assert.equal(
      z.object({ error: z.object({ code: z.string() }) }).parse(JSON.parse(response.body)).error
        .code,
      "invalid_context_selection",
    )
  }
})

test("context rejects a complete authorized selection over the total byte budget", async () => {
  // Given / When
  const response = await fixture.context(fixture.hub.ownerToken, {
    references: [{ kind: "page", id: "b-visible", revision: 1 }],
    maxBytes: 1,
  })

  // Then
  assert.equal(response.status, 422, response.body)
  assert.equal(
    z.object({ error: z.object({ code: z.string() }) }).parse(JSON.parse(response.body)).error.code,
    "context_budget_exceeded",
  )
})

test("context contentBytes counts the complete serialized items array as UTF-8", async () => {
  // Given / When
  const response = await fixture.context(fixture.hub.ownerToken, {
    references: [{ kind: "page", id: "unicode-page", revision: 1 }],
  })

  // Then
  assert.equal(response.status, 200, response.body)
  const body = ContextReadResponseSchema.parse(JSON.parse(response.body))
  assert.equal(body.contentBytes, Buffer.byteLength(JSON.stringify(body.items), "utf8"))
})

test("context checks every exact revision before enforcing the byte budget", async () => {
  // Given / When
  const response = await fixture.context(fixture.hub.ownerToken, {
    references: [
      { kind: "page", id: "b-visible", revision: 1 },
      { kind: "knowledge", id: "knowledge-visible", revision: 999 },
    ],
    maxBytes: 1,
  })

  // Then
  assert.equal(response.status, 404, response.body)
})

test("context authorizes every reference before reporting a byte budget error", async () => {
  // Given / When
  const response = await fixture.context(fixture.contentReaderToken, {
    references: [
      { kind: "page", id: "b-visible", revision: 1 },
      { kind: "knowledge", id: "knowledge-visible", revision: 1 },
    ],
    maxBytes: 1,
  })

  // Then
  assert.equal(response.status, 404, response.body)
})

test("workflow routes hide a different workspace", async () => {
  // Given / When
  const response = await fixture.get(
    "/api/content/v1/workspaces/other/documents?kind=page",
    fixture.hub.ownerToken,
  )

  // Then
  assert.equal(response.status, 404, response.body)
})

test("templates require the content.read workspace grant", async () => {
  // Given / When
  const response = await fixture.get(
    "/api/content/v1/workspaces/workspace/templates",
    fixture.knowledgeReaderToken,
  )

  // Then
  assert.equal(response.status, 404, response.body)
})

test("context route hides a different workspace", async () => {
  // Given / When
  const response = await fixture.hub.post(
    "/api/content/v1/workspaces/other/context",
    fixture.hub.ownerToken,
    JSON.stringify({ references: [{ kind: "page", id: "b-visible", revision: 1 }] }),
  )

  // Then
  assert.equal(response.status, 404, response.body)
})
