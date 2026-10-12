import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, test } from "node:test"
import { ProjectPageSchema, QueryPageSchema } from "../src/contracts/r4/index.ts"
import { createR4HumanRouter } from "../src/http/human-v1/human-router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let server: Server
let endpoint: string
let viewerToken: string
let stateId: string
let spaceEntityId: string
beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  const admin = new IdentityAdmin(fixture.sql)
  await admin.bootstrapWorkspace({
    workspaceId: "metadata",
    workspaceName: "Metadata",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await admin.provisionPrincipal({
    workspaceId: "metadata",
    principalId: "viewer",
    displayName: "Viewer",
    kind: "human",
    role: "member",
    permissions: ["work.read", "space.read", "project.read"],
  })
  viewerToken = (
    await admin.issueToken({
      workspaceId: "metadata",
      principalId: "viewer",
      expiresAt: "2030-01-01T00:00:00.000Z",
    })
  ).token
  await seedMetadataGraph()
  server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-12T00:00:00.000Z",
    },
    [createR4HumanRouter(fixture.sql, randomBytes(32))],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("missing address")
  endpoint = `http://127.0.0.1:${(address satisfies AddressInfo).port}/api/human/v1/workspaces/metadata`
})
afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  await fixture.close()
})
test("Work detail and query omit an item when workflow-state metadata is unreadable", async () => {
  // Given
  await restrict(stateId)

  // When
  const [detail, page] = await Promise.all([request("/work-items/work"), query(null)])

  // Then
  assert.equal(detail.status, 404)
  assert.equal(page.completeness.matched, 0)
  assert.deepEqual(page.items, [])
})
test("Work detail and query omit an item when Space metadata is unreadable", async () => {
  // Given
  await restrict(spaceEntityId)

  // When
  const [detail, page] = await Promise.all([request("/work-items/work"), query(null)])

  // Then
  assert.equal(detail.status, 404)
  assert.equal(page.completeness.matched, 0)
  assert.deepEqual(page.items, [])
})
test("Project null filters treat an unreadable reference as absent under negation", async () => {
  // Given
  await restrict("project")

  // When
  const [isNull, isPresent, negatedNull, hiddenEquality] = await Promise.all([
    query({ op: "is_null", field: "projectId", value: true }),
    query({ op: "is_null", field: "projectId", value: false }),
    query({ op: "not", filter: { op: "is_null", field: "projectId", value: true } }),
    query({ op: "not", filter: { op: "eq", field: "projectId", value: "project" } }),
  ])

  // Then
  assert.deepEqual(
    isNull.items.map((item) => [item.id, item.project]),
    [["work", null]],
  )
  assert.equal(isPresent.completeness.matched, 0)
  assert.equal(negatedNull.completeness.matched, 0)
  assert.equal(hiddenEquality.completeness.matched, 0)
})
test("authorized reference filters and metadata projections remain available", async () => {
  // Given
  const filter = { op: "eq", field: "projectId", value: "project" } as const

  // When
  const [detail, page] = await Promise.all([request("/work-items/work"), query(filter)])

  // Then
  assert.equal(detail.status, 200)
  assert.deepEqual(
    page.items.map((item) => item.project),
    [{ id: "project", name: "Project" }],
  )
  assert.equal(page.items[0]?.space.name, "Public")
  assert.equal(page.items[0]?.workflowState.id, stateId)
})
test("Project Space null filters ignore unreadable associations under negation", async () => {
  // Given
  await restrict(spaceEntityId)

  // When
  const [isNull, isPresent, negatedNull] = await Promise.all([
    queryProjects({ op: "is_null", field: "spaceId", value: true }),
    queryProjects({ op: "is_null", field: "spaceId", value: false }),
    queryProjects({ op: "not", filter: { op: "is_null", field: "spaceId", value: true } }),
  ])

  // Then
  assert.deepEqual(
    isNull.items.map((project) => project.id),
    ["project"],
  )
  assert.equal(isPresent.matched, 0)
  assert.equal(negatedNull.matched, 0)
})

test("reference ranges evaluate only readable metadata", async () => {
  for (const [field, value] of [
    ["spaceId", "public"],
    ["projectId", "project"],
    ["workflowStateId", stateId],
    ["labelId", "label"],
  ] as const) {
    const page = await query({ op: "range", field, from: value, to: value })
    assert.deepEqual(
      page.items.map((item) => item.id),
      ["work"],
    )
  }
  await restrict("project")
  await restrict("label")
  const hiddenProject = { op: "range", field: "projectId", from: "a", to: "z" } as const
  const [range, negated, labelRange] = await Promise.all([
    query(hiddenProject),
    query({ op: "not", filter: hiddenProject }),
    query({ op: "range", field: "labelId", from: "a", to: "z" }),
  ])
  assert.deepEqual([range.completeness.matched, negated.completeness.matched], [0, 0])
  assert.equal(labelRange.completeness.matched, 0)
})

test("Project Space ranges ignore unreadable associations", async () => {
  const range = { op: "range", field: "spaceId", from: "a", to: "z" } as const
  assert.equal((await queryProjects(range)).matched, 1)
  await restrict(spaceEntityId)
  assert.equal((await queryProjects(range)).matched, 0)
})

async function seedMetadataGraph(): Promise<void> {
  await fixture.sql`insert into spaces(workspace_id,id,name,visibility)
    values('metadata','public','Public','public')`
  await fixture.sql`select initialize_r4_space('metadata','public','PUB','owner',true)`
  const [metadata] = await fixture.sql<
    { readonly state_id: string; readonly space_entity_id: string }[]
  >`select ws.id state_id,se.id space_entity_id from workflow_states ws join entities se
    on se.workspace_id=ws.workspace_id and se.kind='space' and se.scope_space_id=ws.space_id
    where ws.workspace_id='metadata' and ws.space_id='public' and ws.is_default`
  if (metadata === undefined) throw new TypeError("Space metadata missing")
  stateId = metadata.state_id
  spaceEntityId = metadata.space_entity_id
  await fixture.sql`insert into entities
    (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    values('project','metadata','project',1,'owner',now(),now())`
  await fixture.sql`insert into entity_acl_policies values('project','inherit')`
  await fixture.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    values('label','metadata','label','public',1,'owner',now(),now())`
  await fixture.sql`insert into entity_acl_policies values('label','inherit')`
  await fixture.sql`insert into labels(id,workspace_id,space_id,name,color,revision)
    values('label','metadata','public','Label','blue',1)`
  await fixture.sql`insert into projects
    (id,workspace_id,name,slug,owner_id,state,health,priority,revision,created_at,updated_at)
    values('project','metadata','Project','project','owner','active','on_track','none',1,now(),now())`
  await fixture.sql`insert into project_spaces values('project','metadata','public')`
  await fixture.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    select p.id,1,'project.r4.v1',to_jsonb(p)||jsonb_build_object('participatingSpaceIds','[]'::jsonb),
      'owner',p.updated_at,encode(public.digest(convert_to((to_jsonb(p)||jsonb_build_object(
      'participatingSpaceIds','[]'::jsonb))::text,'utf8'),'sha256'),'hex') from projects p where p.id='project'`
  await fixture.sql`insert into work_items
    (id,workspace_id,space_id,title,state,accountable_owner_id,revision,created_at,updated_at)
    values('work','metadata','public','Work','unstarted','owner',1,now(),now())`
  await fixture.sql`update work_item_pm set project_id='project' where work_item_id='work'`
  await fixture.sql`insert into work_item_labels values('work','label')`
  await fixture.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    select id,workspace_id,'work_item',space_id,revision,'owner',created_at,updated_at
    from work_items where id='work'`
  await fixture.sql`insert into entity_acl_policies values('work','inherit')`
  await fixture.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    select w.id,1,'work-item.r4.v1',snapshot.value,'owner',w.updated_at,
      encode(public.digest(convert_to(snapshot.value::text,'utf8'),'sha256'),'hex')
    from work_items w join work_item_pm pm on pm.work_item_id=w.id
    cross join lateral (select to_jsonb(w)||to_jsonb(pm)||jsonb_build_object('labelIds','[]'::jsonb) value) snapshot
    where w.id='work'`
}

async function restrict(entityId: string): Promise<void> {
  await fixture.sql`update entity_acl_policies set mode='restricted' where entity_id=${entityId}`
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${endpoint}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${viewerToken}`, "content-type": "application/json" },
  })
}

async function query(filter: unknown) {
  const response = await request("/work-items/query", {
    method: "POST",
    body: JSON.stringify(queryBody(filter)),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return QueryPageSchema.parse(await response.json())
}

async function queryProjects(filter: unknown) {
  const response = await request("/projects/query", {
    method: "POST",
    body: JSON.stringify({ ...queryBody(filter), model: undefined }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return ProjectPageSchema.parse(await response.json())
}

function queryBody(filter: unknown) {
  return {
    model: "r4",
    filter,
    search: null,
    sort: [{ field: "createdAt", direction: "asc" }],
    includeArchived: false,
    page: { size: 100, cursor: null },
  }
}
