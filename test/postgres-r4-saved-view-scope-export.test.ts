import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createInterchangeHttpFixture } from "./r4-interchange-http-fixture.ts"

type SpaceSetup = {
  readonly id: string
  readonly key: string
  readonly name: string
  readonly visibility: "public" | "private"
}

type RelationEndpointKind = "label" | "workflow_state" | "space"

let fixture: Awaited<ReturnType<typeof createInterchangeHttpFixture>>

beforeEach(async () => {
  fixture = await createInterchangeHttpFixture()
})

afterEach(async () => fixture.close())

test("scoped export omits a global Saved View that only references an outside Project", async () => {
  const inside = await createProject("inside", "inside-project")
  const outside = await createProject("outside", "outside-project")
  await createView("selected-scope-view", "inside", {
    op: "eq",
    field: "projectId",
    value: inside,
  })
  await createView("outside-global-view", null, {
    op: "eq",
    field: "projectId",
    value: outside,
  })
  await createView("selected-global-range", null, {
    op: "range",
    field: "projectId",
    from: inside,
    to: inside,
  })
  await createView("zero-reference-global-view", null, null)
  const absentLabelId = randomUUID()
  await createView("empty-label-range-global-view", null, {
    op: "range",
    field: "labelId",
    from: absentLabelId,
    to: absentLabelId,
  })

  const response = await exportProject(inside)
  const output = await response.text()

  assert.equal(response.status, 200, output)
  assert.match(output, /selected-scope-view/)
  assert.match(output, /selected-global-range/)
  assert.doesNotMatch(output, /outside-global-view/)
  assert.doesNotMatch(output, /zero-reference-global-view/)
  assert.doesNotMatch(output, /empty-label-range-global-view/)
  assert.equal(output.includes(outside), false)
})

test("scoped export rejects a relevant Saved View with an outside Project reference", async () => {
  const inside = await createProject("inside", "inside-project")
  const outside = await createProject("outside", "outside-project")
  await createView("mixed-global-view", null, {
    op: "in",
    field: "projectId",
    values: [inside, outside],
  })

  const response = await exportProject(inside)

  await assertNonportable(response)
})

test("workspace export retains a global Saved View and its referenced Project", async () => {
  await createProject("inside", "inside-project")
  const outside = await createProject("outside", "outside-project")
  await createView("outside-global-view", null, {
    op: "eq",
    field: "projectId",
    value: outside,
  })

  const response = await fixture.request("/api/human/v1/workspaces/w/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ includeArchived: true }),
  })
  const output = await response.text()

  assert.equal(response.status, 200, output)
  assert.match(output, /outside-global-view/)
  assert.equal(output.includes(outside), true)
})

test("scoped export omits an unreadable Space reference that aliases the selected Project ID", async () => {
  const projectId = await createProject("inside", "inside-project")
  await createSpace({ id: projectId, key: "ALS", name: "Alias", visibility: "private" })
  await createView("unreadable-alias-view", null, {
    op: "eq",
    field: "spaceId",
    value: projectId,
  })
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

  const response = await exportProject(projectId, reader.token)
  const output = await response.text()

  assert.equal(response.status, 200, output)
  assert.doesNotMatch(output, /unreadable-alias-view/)
})

for (const kind of ["label", "workflow_state", "space"] as const) {
  test(`scoped export rejects a relation to an in-scope ${kind}`, async () => {
    const endpoints = await createRelationEndpoints(kind)
    await createView(`inside-${kind}-relation`, null, {
      op: "relation",
      relationType: "supports",
      entityId: endpoints.inside,
    })

    const response = await exportProject(endpoints.projectId)

    await assertNonportable(response)
  })

  test(`scoped export omits a relation to an outside ${kind}`, async () => {
    const endpoints = await createRelationEndpoints(kind)
    await createView(`outside-${kind}-relation`, null, {
      op: "relation",
      relationType: "supports",
      entityId: endpoints.outside,
    })

    const response = await exportProject(endpoints.projectId)
    const output = await response.text()

    assert.equal(response.status, 200, output)
    assert.doesNotMatch(output, new RegExp(`outside-${kind}-relation`))
  })
}

async function createRelationEndpoints(kind: RelationEndpointKind) {
  const projectId = await createProject("inside", "inside-project")
  const outsideSpaceId = kind === "space" ? projectId : "outside"
  await createSpace({ id: outsideSpaceId, key: "OUT", name: "outside", visibility: "public" })
  if (kind === "label") {
    return {
      projectId,
      inside: await command("/spaces/inside/labels", { name: "Inside", color: "blue" }),
      outside: await command(`/spaces/${outsideSpaceId}/labels`, { name: "Outside", color: "red" }),
    }
  }
  if (kind === "workflow_state") {
    const states = await fixture.sql<{ readonly id: string; readonly space_id: string }[]>`
      select id,space_id from workflow_states where workspace_id='w' and is_default
        and space_id in ('inside',${outsideSpaceId})`
    const inside = states.find((state) => state.space_id === "inside")
    const outside = states.find((state) => state.space_id === outsideSpaceId)
    if (inside === undefined || outside === undefined) throw new TypeError("default state missing")
    return { projectId, inside: inside.id, outside: outside.id }
  }
  const [spaces] = await fixture.sql<
    [{ readonly inside: string; readonly outside: string }]
  >`select stable_space_entity_id('w','inside') inside,
      stable_space_entity_id('w',${outsideSpaceId}) outside`
  return { projectId, inside: spaces.inside, outside: spaces.outside }
}

async function assertNonportable(response: Response): Promise<void> {
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: {
      code: "nonportable_graph",
      message: "nonportable_graph",
      retryable: false,
      details: {},
    },
  })
}

async function createProject(spaceId: string, slug: string): Promise<string> {
  await createSpace({
    id: spaceId,
    key: slug === "inside-project" ? "INS" : "OUT",
    name: spaceId,
    visibility: "public",
  })
  return command("/projects", {
    name: slug,
    slug,
    summary: "",
    ownerId: "owner",
    leadIds: [],
    participatingSpaceIds: [spaceId],
    state: "active",
    health: "on_track",
    priority: "none",
    startDate: null,
    targetDate: null,
  })
}

async function createSpace(space: SpaceSetup): Promise<string> {
  return command("/spaces", {
    id: space.id,
    key: space.key,
    name: space.name,
    visibility: space.visibility,
    description: "",
    icon: null,
    leadId: null,
  })
}

function createView(
  name: string,
  scopeSpaceId: string | null,
  filter: object | null,
): Promise<string> {
  return command("/saved-views", {
    name,
    access: scopeSpaceId === null ? "workspace" : "space",
    scopeSpaceId,
    definition: {
      model: "r4",
      filter,
      search: null,
      sort: [{ field: "updatedAt", direction: "desc" }],
      includeArchived: false,
      page: { size: 50, cursor: null },
    },
  })
}

function exportProject(projectId: string, token?: string): Promise<Response> {
  return fixture.request("/api/human/v1/workspaces/w/export", {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    body: JSON.stringify({ includeArchived: true, projectId }),
  })
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
