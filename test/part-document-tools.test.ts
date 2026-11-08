import assert from "node:assert/strict"
import { test } from "node:test"
import { localContext } from "@slop-lab/part/contracts/index.js"
import { createToolDispatcher } from "@slop-lab/part/tools.js"
import { createWorkspaceToolBundle, describeWorkspaceTools } from "../src/agent-tools/index.ts"

test("the default agent catalog discovers documents and exact context without write authority", () => {
  // Given
  const catalog = describeWorkspaceTools()
  const expected = ["document_templates", "documents_find", "document_context"]

  // When
  const documentTools = catalog.filter((tool) => expected.includes(tool.id))

  // Then
  assert.deepEqual(documentTools.map((tool) => tool.id).sort(), expected.sort())
  assert.ok(documentTools.every((tool) => tool.effects === "read"))
  assert.ok(catalog.every((tool) => tool.effects === "read"))
})

test("document tool arguments cannot supply actors or install Knowledge acceptance", async () => {
  const bundle = createWorkspaceToolBundle({
    origin: "http://127.0.0.1:3001",
    workspaceId: "workspace",
    token: () => "unused-test-credential",
  })
  try {
    const dispatcher = createToolDispatcher({ tools: bundle.tools })
    if (!dispatcher.ok) throw new TypeError("dispatcher setup failed")
    const actor = await dispatcher.value.dispatch(
      {
        logicalCallId: "actor-override",
        toolId: "document_context",
        arguments: {
          references: [{ kind: "page", id: "example", revision: 1 }],
          actorId: "another-principal",
        },
      },
      localContext(),
    )
    const acceptance = await dispatcher.value.dispatch(
      { logicalCallId: "acceptance", toolId: "knowledge_accept", arguments: {} },
      localContext(),
    )
    assert.equal(actor.ok, false)
    assert.equal(acceptance.ok, false)
  } finally {
    await bundle.close()
  }
})
