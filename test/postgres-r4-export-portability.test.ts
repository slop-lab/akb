import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createInterchangeHttpFixture } from "./r4-interchange-http-fixture.ts"

let fixture: Awaited<ReturnType<typeof createInterchangeHttpFixture>>

beforeEach(async () => {
  fixture = await createInterchangeHttpFixture()
})

afterEach(async () => fixture.close())

test("export rejects a v1 graph with duplicate cross-kind external IDs", async () => {
  // Given
  await command("/spaces", {
    id: "anchor",
    key: "ANC",
    name: "Anchor",
    visibility: "private",
    description: "",
    icon: null,
    leadId: null,
  })
  const projectId = await command("/projects", {
    name: "Collision",
    slug: "collision",
    summary: "",
    ownerId: "owner",
    leadIds: [],
    participatingSpaceIds: ["anchor"],
    state: "active",
    health: "on_track",
    priority: "none",
    startDate: null,
    targetDate: null,
  })
  await command("/spaces", {
    id: projectId,
    key: "COL",
    name: "Collision",
    visibility: "private",
    description: "",
    icon: null,
    leadId: null,
  })

  // When
  const response = await fixture.request("/api/human/v1/workspaces/w/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ includeArchived: true }),
  })

  // Then
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: {
      code: "nonportable_graph",
      message: "nonportable_graph",
      retryable: false,
      details: {},
    },
  })
})

for (const spaceId of [undefined, "visible-space"] as const) {
  test(`export omits Saved Views with unreadable exact references from ${spaceId ?? "workspace"} exports`, async () => {
    await command("/spaces", {
      id: "visible-space",
      key: "VIS",
      name: "Visible Space",
      visibility: "public",
      description: "",
      icon: null,
      leadId: null,
    })
    await command("/spaces", {
      id: "secret-space-reference",
      key: "SEC",
      name: "Secret Space",
      visibility: "private",
      description: "",
      icon: null,
      leadId: null,
    })
    const projectId = await command("/projects", {
      name: "Secret Project",
      slug: "secret-project",
      summary: "",
      ownerId: "owner",
      leadIds: [],
      participatingSpaceIds: ["visible-space"],
      state: "active",
      health: "on_track",
      priority: "none",
      startDate: null,
      targetDate: null,
    })
    const labelId = await command("/spaces/visible-space/labels", {
      name: "Secret Label",
      color: "blue",
    })
    const [state] = await fixture.sql<{ readonly id: string }[]>`
      select id from workflow_states where workspace_id='w' and space_id='visible-space'
        and is_default`
    if (state === undefined) throw new TypeError("default workflow state missing")
    const workStateId = await command("/spaces/visible-space/workflow/states", {
      name: "Readable",
      category: "started",
      color: "blue",
      position: 10,
      isDefault: false,
    })
    await command("/work-items", {
      spaceId: "visible-space",
      title: "No Project",
      accountableOwnerId: "owner",
      description: "",
      type: "Task",
      workflowStateId: workStateId,
      projectId: null,
      priority: "none",
      labelIds: [],
      startDate: null,
      dueDate: null,
    })
    const exactReferences = {
      projectId,
      workflowStateId: state.id,
      labelId,
      spaceId: "secret-space-reference",
    }
    for (const [field, value] of Object.entries(exactReferences)) {
      await command("/saved-views", {
        name: `hidden-view-${field}`,
        access: "workspace",
        scopeSpaceId: null,
        definition: definition(
          { op: "range", field, from: value, to: value },
          `secret-search-${field}`,
        ),
      })
    }
    await command("/saved-views", {
      name: "portable-lexical-view",
      access: "workspace",
      scopeSpaceId: null,
      definition: definition(
        { op: "range", field: "projectId", from: "lexical-a", to: "lexical-z" },
        "portable-lexical-search",
      ),
    })
    await command("/saved-views", {
      name: "portable-readable-view",
      access: "workspace",
      scopeSpaceId: null,
      definition: definition(
        { op: "eq", field: "spaceId", value: "visible-space" },
        "portable-readable-search",
      ),
    })
    await command("/saved-views", {
      name: "portable-unbounded-view",
      access: "workspace",
      scopeSpaceId: null,
      definition: definition(
        { op: "range", field: "projectId", from: null, to: null },
        "portable-unbounded-search",
      ),
    })
    await command("/saved-views", {
      name: "negated-unbounded-view",
      access: "workspace",
      scopeSpaceId: null,
      definition: definition(
        {
          op: "not",
          filter: { op: "range", field: "projectId", from: null, to: null },
        },
        "negated-unbounded-search",
      ),
    })
    await fixture.sql`update entity_acl_policies set mode='restricted' where entity_id in
      (${projectId},${state.id},${labelId},stable_space_entity_id('w','secret-space-reference'))`
    const identity = new IdentityAdmin(fixture.sql)
    await identity.provisionPrincipal({
      workspaceId: "w",
      principalId: "reader",
      displayName: "Reader",
      kind: "human",
      role: "member",
      permissions: ["work.read", "space.read", "project.read", "view.read"],
    })
    const reader = await identity.issueToken({
      workspaceId: "w",
      principalId: "reader",
      expiresAt: "2030-01-01T00:00:00.000Z",
    })

    const response = await fixture.request("/api/human/v1/workspaces/w/export", {
      method: "POST",
      headers: {
        authorization: `Bearer ${reader.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        includeArchived: true,
        ...(spaceId === undefined ? {} : { spaceId }),
      }),
    })
    const output = await response.text()

    assert.equal(response.status, 200, output)
    for (const [field, value] of Object.entries(exactReferences)) {
      assert.doesNotMatch(output, new RegExp(`hidden-view-${field}|secret-search-${field}`))
      assert.equal(output.includes(value), false)
    }
    if (spaceId === undefined) {
      assert.match(output, /portable-lexical-view/)
      assert.match(output, /portable-lexical-search/)
    } else {
      assert.doesNotMatch(output, /portable-lexical-view|portable-lexical-search/)
      assert.doesNotMatch(output, /negated-unbounded-view|negated-unbounded-search/)
    }
    assert.match(output, /portable-unbounded-view/)
    assert.match(output, /portable-unbounded-search/)
    assert.match(output, /portable-readable-view/)
    assert.match(output, /portable-readable-search/)
    assert.doesNotMatch(output, /"kind":"project"/)
  })
}

function definition(filter: Readonly<Record<string, unknown>>, search: string) {
  return {
    model: "r4",
    filter,
    search,
    sort: [{ field: "updatedAt", direction: "desc" }],
    includeArchived: false,
    page: { size: 50, cursor: null },
  }
}

async function command(path: string, payload: unknown): Promise<string> {
  const key = randomUUID()
  const response = await fixture.request(`/api/commands/v1/workspaces/w${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: key, idempotencyKey: key, baseRevision: null, payload }),
  })
  assert.equal(response.status, 201, await response.clone().text())
  return z
    .object({ result: z.object({ id: z.string() }).loose() })
    .loose()
    .parse(await response.json()).result.id
}
