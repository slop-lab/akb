import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { localContext } from "@slop-lab/part/contracts/index.js"
import type { Contracts } from "@slop-lab/part/reference/index.js"
import { createToolDispatcher } from "@slop-lab/part/tools.js"
import { z } from "zod"
import type { WorkspaceToolBundle } from "../../src/agent-runtime/types.ts"
import { createWorkspaceToolBundle } from "../../src/agent-tools/index.ts"
import { ContentDocumentSchema } from "../../src/contracts/content/model.ts"
import {
  ContentDocumentDiscoveryResponseSchema,
  ContextReadResponseSchema,
} from "../../src/contracts/content/workflow.ts"
import { WorkHubPostgresFixture } from "../knowledge-work-hub-postgres-fixture.ts"

let fixture: WorkHubPostgresFixture
const document = (text: string) => ({
  version: 1,
  blocks: [{ id: "body", type: "paragraph", text, children: [] }],
})

before(async () => {
  fixture = await WorkHubPostgresFixture.create()
  const created = await fixture.contentCommand("/pages", "POST", null, {
    pageId: "agent-guidance",
    title: "Agent guidance",
    document: document("Original operating guidance"),
  })
  assert.equal(created.status, 201)
  const changed = await fixture.contentCommand("/pages/agent-guidance", "PATCH", 1, {
    document: document("New operating guidance"),
  })
  assert.equal(changed.status, 200)
})

after(async () => fixture.close())

test("Part document discovery reads authorized summaries through the real HTTP and database boundary", async (context) => {
  // Given
  const bundle = tools()
  context.after(() => bundle.close())

  // When
  const value = await completed(bundle, "documents_find", {
    kind: "page",
    query: "Agent",
    limit: 1,
  })

  // Then
  const result = ContentDocumentDiscoveryResponseSchema.parse(value)
  assert.equal(result.consistency, "live")
  assert.equal(result.items[0]?.id, "agent-guidance")
  assert.equal(result.items[0]?.revision, 2)
  assert.equal(JSON.stringify(result).includes("operating guidance"), false)
})

test("Part context reads retain the requested historical body after the latest Page changes", async (context) => {
  // Given
  const bundle = tools()
  context.after(() => bundle.close())

  // When
  const value = await completed(bundle, "document_context", {
    references: [{ kind: "page", id: "agent-guidance", revision: 1 }],
    maxBytes: 65_536,
  })

  // Then
  const result = ContextReadResponseSchema.parse(value)
  const item = result.items[0]
  assert.equal(item?.revision, 1)
  const snapshot = z.object({ document: ContentDocumentSchema }).parse(item?.snapshot)
  assert.equal(snapshot.document.blocks[0]?.text, "Original operating guidance")
  assert.equal(result.scope, "explicit-selection")
  const runs = await fixture.database.sql<{ readonly total: number }[]>`
    select count(*)::integer total from runtime_runs`
  assert.equal(runs[0]?.total, 0)
})

test("Part context fails after source permission revocation without leaking the body", async (context) => {
  // Given
  const bundle = tools()
  context.after(() => bundle.close())
  await fixture.admin.setPermissions({
    workspaceId: "workspace",
    principalId: "work-hub",
    permissions: ["knowledge.read", "knowledge.propose"],
  })
  try {
    // When
    const outcome = await dispatch(bundle, "document_context", {
      references: [{ kind: "page", id: "agent-guidance", revision: 1 }],
    })

    // Then
    assert.equal(outcome.phase, "failed")
    assert.equal(JSON.stringify(outcome).includes("Original operating guidance"), false)
    assert.equal(JSON.stringify(outcome).includes(fixture.connectorToken), false)
  } finally {
    await fixture.admin.setPermissions({
      workspaceId: "workspace",
      principalId: "work-hub",
      permissions: ["content.read", "knowledge.read", "knowledge.propose"],
    })
  }
})

function tools(): WorkspaceToolBundle {
  return createWorkspaceToolBundle({
    origin: fixture.origin,
    workspaceId: "workspace",
    token: () => fixture.connectorToken,
  })
}

async function dispatch(bundle: WorkspaceToolBundle, toolId: string, arguments_: Contracts.Json) {
  const dispatcher = createToolDispatcher({ tools: bundle.tools })
  if (!dispatcher.ok) throw new TypeError("tool dispatcher is unavailable")
  const admitted = await dispatcher.value.dispatch(
    { logicalCallId: crypto.randomUUID(), toolId, arguments: arguments_ },
    localContext(),
  )
  if (!admitted.ok) throw new TypeError("document tool request was rejected")
  return admitted.value.done
}

async function completed(bundle: WorkspaceToolBundle, toolId: string, arguments_: Contracts.Json) {
  const outcome = await dispatch(bundle, toolId, arguments_)
  switch (outcome.phase) {
    case "completed":
      return outcome.result.value
    case "failed":
    case "cancelled":
    case "abandoned":
      assert.fail(`document tool did not complete: ${outcome.phase}`)
  }
}
