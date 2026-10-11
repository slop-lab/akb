import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { BoardService } from "../src/human-query/board-service.ts"
import { decodeCursor, encodeCursor } from "../src/human-query/cursor.ts"
import { ProjectQueryService } from "../src/human-query/project-query-service.ts"
import { HumanQueryService, SnapshotConflictError } from "../src/human-query/service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
})

afterEach(async () => {
  await fixture.close()
})

test("cursor rejects tampering and a different actor when bindings are verified", () => {
  // Given
  const key = randomBytes(32)
  const binding = {
    snapshotId: randomUUID(),
    ordinal: 100,
    group: null,
    principalId: "p1",
    credentialId: "c1",
    workspaceId: "w1",
    queryHash: "a".repeat(64),
    sortHash: "b".repeat(64),
    pageSize: 100,
    authorityHash: "c".repeat(64),
    authorityEpoch: 1,
    expiresAt: "2030-01-01T00:00:00.000Z",
  } as const
  const cursor = encodeCursor(binding, key)

  // When / Then
  assert.deepEqual(decodeCursor(cursor, key), binding)
  assert.throws(() => decodeCursor(`${cursor.slice(0, -1)}x`, key), /invalid cursor/)
  assert.notEqual(decodeCursor(cursor, key).principalId, "p2")
})

test("work query excludes unauthorized candidates before matched counts", async () => {
  // Given
  const admin = new IdentityAdmin(fixture.sql)
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "query",
    workspaceName: "Query",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(fixture.sql, issued.token)
  if (principal === undefined) throw new TypeError("fixture authentication failed")
  await seedWorkItems()
  const service = new HumanQueryService(fixture.sql, randomBytes(32))

  // When
  const page = await service.queryWorkItems(principal, "query", {
    model: "r4",
    filter: null,
    search: "Hidden OR Visible",
    sort: [{ field: "createdAt", direction: "asc" }],
    includeArchived: false,
    page: { size: 100, cursor: null },
  })

  // Then
  assert.equal(page.completeness.matched, 1)
  assert.deepEqual(
    page.items.map((item) => item.title),
    ["Visible"],
  )
})

test("relation filters require kind-specific read authority for both endpoints", async () => {
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "query",
    workspaceName: "Query",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(fixture.sql, issued.token)
  if (principal === undefined) throw new TypeError("fixture authentication failed")
  await seedWorkItems()
  await seedProject("project", "Project", "project")
  await seedRelation("work-relation", "hidden", "visible")
  await seedRelation("project-relation", "hidden", "project")
  const filter = { op: "relation", relationType: "related_to", entityId: "hidden" } as const

  const [work, projects] = await Promise.all([
    new HumanQueryService(fixture.sql, randomBytes(32)).queryWorkItems(principal, "query", {
      model: "r4",
      filter,
      search: null,
      sort: [{ field: "createdAt", direction: "asc" }],
      includeArchived: false,
      page: { size: 100, cursor: null },
    }),
    new ProjectQueryService(fixture.sql, randomBytes(32)).queryProjects(principal, "query", {
      filter,
      search: null,
      sort: [{ field: "createdAt", direction: "asc" }],
      includeArchived: false,
      page: { size: 100, cursor: null },
    }),
  ])

  assert.equal(work.completeness.matched, 0)
  assert.equal(projects.matched, 0)
})

test("work query continuation returns the materialized source revision after a concurrent update", async () => {
  // Given
  const admin = new IdentityAdmin(fixture.sql)
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "query",
    workspaceName: "Query",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(fixture.sql, issued.token)
  if (principal === undefined) throw new TypeError("fixture authentication failed")
  await seedWorkItems()
  await seedVisibleWorkItem("visible-later", "Visible Z")
  const service = new HumanQueryService(fixture.sql, randomBytes(32))
  const query = {
    model: "r4",
    filter: null,
    search: null,
    sort: [{ field: "title", direction: "asc" }],
    includeArchived: false,
    page: { size: 1, cursor: null },
  } as const
  const firstPage = await service.queryWorkItems(principal, "query", query)
  assert.notEqual(firstPage.nextCursor, null)
  await fixture.sql`update work_items set title='Changed',revision=2,updated_at=clock_timestamp()
    where id='visible-later'`
  await fixture.sql`update entities set current_revision=2,updated_at=clock_timestamp()
    where id='visible-later'`
  await appendCurrentWorkRevision("visible-later")

  // When
  const secondPage = await service.queryWorkItems(principal, "query", {
    ...query,
    page: { size: 1, cursor: firstPage.nextCursor },
  })

  // Then
  assert.deepEqual(
    secondPage.items.map((item) => [item.title, item.revision]),
    [["Visible Z", 1]],
  )
})

test("board columns page independently from frozen state membership and reject another group", async () => {
  // Given
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "query",
    workspaceName: "Query",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(fixture.sql, issued.token)
  if (principal === undefined) throw new TypeError("fixture authentication failed")
  await seedWorkItems()
  await seedVisibleWorkItem("visible-later", "Visible Z")
  const key = randomBytes(32)
  const service = new BoardService(fixture.sql, key)
  const initial = {
    model: "r4",
    filter: { op: "eq", field: "spaceId", value: "public" },
    search: null,
    sort: [{ field: "title", direction: "asc" }],
    includeArchived: false,
    workflowStateId: null,
    page: { size: 1, cursor: null },
  } as const
  const board = await service.query(principal, "query", initial)
  const unstarted = board.columns.find((column) => column.state.category === "unstarted")
  if (unstarted?.nextCursor === null || unstarted === undefined) {
    throw new TypeError("unstarted continuation missing")
  }
  await fixture.sql`update work_items set title='Changed',state='started',revision=2,
    updated_at=clock_timestamp() where id='visible-later'`
  await fixture.sql`update entities set current_revision=2,updated_at=clock_timestamp()
    where id='visible-later'`
  await appendCurrentWorkRevision("visible-later")

  // When
  const continued = await service.query(principal, "query", {
    ...initial,
    workflowStateId: unstarted.state.id,
    page: { size: 1, cursor: unstarted.nextCursor },
  })

  // Then
  assert.deepEqual(
    continued.columns[0]?.cards.map((card) => [card.title, card.revision, card.stateCategory]),
    [["Visible Z", 1, "unstarted"]],
  )
  const startedId = board.columns.find((column) => column.state.category === "started")?.state.id
  if (startedId === undefined) throw new TypeError("started column missing")
  await assert.rejects(
    service.query(principal, "query", {
      ...initial,
      workflowStateId: startedId,
      page: { size: 1, cursor: unstarted.nextCursor },
    }),
    SnapshotConflictError,
  )
})

test("project query continuation returns the materialized source revision after a concurrent update", async () => {
  // Given
  const admin = new IdentityAdmin(fixture.sql)
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "query",
    workspaceName: "Query",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(fixture.sql, issued.token)
  if (principal === undefined) throw new TypeError("fixture authentication failed")
  await seedProject("project-a", "Alpha", "alpha")
  await seedProject("project-z", "Zulu", "zulu")
  const service = new ProjectQueryService(fixture.sql, randomBytes(32))
  const query = {
    filter: null,
    search: null,
    sort: [{ field: "title", direction: "asc" }],
    includeArchived: false,
    page: { size: 1, cursor: null },
  } as const
  const firstPage = await service.queryProjects(principal, "query", query)
  assert.notEqual(firstPage.nextCursor, null)
  await fixture.sql`update projects set name='Changed',revision=2,updated_at=clock_timestamp()
    where id='project-z'`
  await fixture.sql`update entities set current_revision=2,updated_at=clock_timestamp()
    where id='project-z'`
  await appendCurrentProjectRevision("project-z")

  // When
  const secondPage = await service.queryProjects(principal, "query", {
    ...query,
    page: { size: 1, cursor: firstPage.nextCursor },
  })

  // Then
  assert.deepEqual(
    secondPage.items.map((project) => [project.name, project.revision]),
    [["Zulu", 1]],
  )
})

async function seedWorkItems(): Promise<void> {
  await fixture.sql`insert into spaces (workspace_id,id,name,visibility) values
    ('query','public','Public','public'), ('query','private','Private','private')`
  await fixture.sql`select initialize_r4_space('query','public','PUB','owner',true),
    initialize_r4_space('query','private','PVT','owner',true)`
  for (const [id, space, title] of [
    ["visible", "public", "Visible"],
    ["hidden", "private", "Hidden"],
  ] as const) {
    await fixture.sql`insert into work_items
      (id,workspace_id,space_id,title,state,accountable_owner_id,revision,created_at,updated_at)
      values (${id},'query',${space},${title},'unstarted','owner',1,now(),now())`
  }
  await fixture.sql`insert into entities(id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    select id,workspace_id,'work_item',space_id,revision,'owner',created_at,updated_at from work_items where workspace_id='query'`
  await fixture.sql`insert into entity_acl_policies select id,'inherit' from entities where kind='work_item'`
  await appendCurrentWorkRevision("visible")
  await appendCurrentWorkRevision("hidden")
}

async function seedVisibleWorkItem(id: string, title: string): Promise<void> {
  await fixture.sql`insert into work_items
    (id,workspace_id,space_id,title,state,accountable_owner_id,revision,created_at,updated_at)
    values (${id},'query','public',${title},'unstarted','owner',1,clock_timestamp(),clock_timestamp())`
  await fixture.sql`insert into entities(id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    select id,workspace_id,'work_item',space_id,revision,'owner',created_at,updated_at from work_items where id=${id}`
  await fixture.sql`insert into entity_acl_policies values (${id},'inherit')`
  await appendCurrentWorkRevision(id)
}

async function appendCurrentWorkRevision(id: string): Promise<void> {
  await fixture.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    select w.id,w.revision,'work-item.r4.v1',snapshot.value,'owner',w.updated_at,
      encode(public.digest(convert_to(snapshot.value::text,'utf8'),'sha256'),'hex')
    from work_items w join work_item_pm pm on pm.work_item_id=w.id
    cross join lateral (select to_jsonb(w)||to_jsonb(pm)||jsonb_build_object('labelIds','[]'::jsonb) value) snapshot
    where w.id=${id}`
}

async function seedProject(id: string, name: string, slug: string): Promise<void> {
  await fixture.sql`insert into entities
    (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    values (${id},'query','project',1,'owner',clock_timestamp(),clock_timestamp())`
  await fixture.sql`insert into entity_acl_policies values (${id},'inherit')`
  await fixture.sql`insert into projects
    (id,workspace_id,name,slug,owner_id,state,health,priority,revision,created_at,updated_at)
    values (${id},'query',${name},${slug},'owner','active','on_track','none',1,
      clock_timestamp(),clock_timestamp())`
  await appendCurrentProjectRevision(id)
}

async function seedRelation(id: string, from: string, to: string): Promise<void> {
  await fixture.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    values (${id},'query','relation','public',1,'owner',clock_timestamp(),clock_timestamp())`
  await fixture.sql`insert into entity_acl_policies values (${id},'inherit')`
  await fixture.sql`insert into relations
    (id,workspace_id,from_entity_id,relation_type,to_entity_id,revision,asserted_by,valid_from)
    values (${id},'query',${from},'related_to',${to},1,'owner',clock_timestamp())`
}

async function appendCurrentProjectRevision(id: string): Promise<void> {
  await fixture.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    select p.id,p.revision,'project.r4.v1',snapshot.value,'owner',p.updated_at,
      encode(public.digest(convert_to(snapshot.value::text,'utf8'),'sha256'),'hex')
    from projects p cross join lateral (select to_jsonb(p)||jsonb_build_object(
      'participatingSpaceIds','[]'::jsonb) value) snapshot where p.id=${id}`
}
