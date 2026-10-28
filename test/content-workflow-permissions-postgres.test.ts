import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { WorkHubPostgresFixture } from "./knowledge-work-hub-postgres-fixture.ts"

let fixture: WorkHubPostgresFixture
let managerToken: string

before(async () => {
  fixture = await WorkHubPostgresFixture.create()
  await fixture.admin.provisionPrincipal({
    workspaceId: "workspace",
    principalId: "manage-only",
    displayName: "Manage only",
    kind: "human",
    role: "member",
    permissions: ["content.manage"],
  })
  managerToken = (
    await fixture.admin.issueToken({
      workspaceId: "workspace",
      principalId: "manage-only",
      expiresAt: "2030-01-01T00:00:00.000Z",
    })
  ).token
})

after(async () => fixture.close())

test("a manage-only author can obtain static templates without receiving document read access", async () => {
  const templates = await fixture.get(
    "/api/content/v1/workspaces/workspace/templates",
    managerToken,
  )
  assert.equal(templates.status, 200)
  const created = await fixture.post(
    "/api/content/v1/workspaces/workspace/pages",
    managerToken,
    fixture.commandEnvelope(null, {
      pageId: "manage-only-page",
      title: "Manage-only Page",
      document: {
        version: 1,
        blocks: [{ id: "body", type: "paragraph", text: "Private draft", children: [] }],
      },
    }),
  )
  assert.equal(created.status, 201)
  const read = await fixture.get(
    "/api/content/v1/workspaces/workspace/pages/manage-only-page",
    managerToken,
  )
  assert.equal(read.status, 404)
})
