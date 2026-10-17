import assert from "node:assert/strict"
import { test } from "node:test"
import { COMMAND_TOOL_SPECS } from "../src/agent-tools/command-specs.ts"
import { createWorkspaceToolBundle, describeWorkspaceTools } from "../src/agent-tools/index.ts"
import { COMMAND_ROUTES } from "../src/http/command-v1/routes.ts"

test("Workspace Part tools are read-only unless exact actions are selected", () => {
  const reads = describeWorkspaceTools()
  const selected = describeWorkspaceTools(["work-item.create", "comment.create"])

  assert.ok(reads.length >= 10)
  assert.ok(reads.every((tool) => tool.effects === "read"))
  assert.deepEqual(
    selected
      .filter((tool) => tool.effects === "write")
      .map((tool) => tool.action)
      .sort(),
    ["comment.create", "work-item.create"],
  )
  assert.ok(selected.every((tool) => /^[A-Za-z0-9_-]+$/.test(tool.id)))
})

test("the explicit command manifest exactly matches existing R4 routes", () => {
  assert.equal(COMMAND_TOOL_SPECS.length, COMMAND_ROUTES.length)
  for (const spec of COMMAND_TOOL_SPECS) {
    const route = COMMAND_ROUTES.find((candidate) => candidate.action === spec.action)
    assert.ok(route)
    assert.equal(spec.method, route.method)
    assert.equal(spec.create, route.create)
    const pathname = `/api/commands/v1/workspaces/example${spec.path
      .replaceAll(":parentId", "parent")
      .replaceAll(":resourceId", "resource")}`
    assert.ok(route.pattern.test(pathname), spec.action)
    assert.equal(spec.payload, route.payload)
  }
})

test("authority-changing tools cannot be installed by a write allowlist", () => {
  assert.throws(() => describeWorkspaceTools(["space.access"]))
  assert.throws(() => describeWorkspaceTools(["entity.access"]))
})

test("tool configuration rejects credential-bearing or redirected API roots", async () => {
  for (const origin of [
    "https://user:secret@example.com",
    "https://example.com/api",
    "file:///tmp/x",
  ]) {
    assert.throws(() =>
      createWorkspaceToolBundle({ origin, workspaceId: "w", token: () => "unused" }),
    )
  }
  const bundle = createWorkspaceToolBundle({
    origin: "http://127.0.0.1:3001",
    workspaceId: "w",
    token: () => "unused",
  })
  assert.deepEqual(await bundle.close(), { released: [], errors: [], unresolved: [] })
})
