import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { after, test } from "node:test"
import { z } from "zod"
import { createR4HumanRouter } from "../src/http/human-v1/human-router.ts"
import { BoardService } from "../src/human-query/board-service.ts"
import { ProjectQueryService } from "../src/human-query/project-query-service.ts"
import { HumanQueryService, QueryBudgetExceededError } from "../src/human-query/service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const fixture = await createPostgresTestFixture()
after(fixture.close)
const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
  workspaceId: "scale-query",
  workspaceName: "Scale Query",
  principalId: "owner",
  principalName: "Owner",
  expiresAt: "2030-01-01T00:00:00.000Z",
})
const principal = await authenticateToken(fixture.sql, issued.token)
if (principal === undefined) throw new TypeError("fixture authentication failed")
await fixture.sql`set statement_timeout='10min'`
await fixture.sql`insert into spaces(workspace_id,id,name,visibility)
  values('scale-query','all','All','public')`
await fixture.sql`select initialize_r4_space('scale-query','all','ALL','owner',true)`
await seedWorkItems(100_000)
const signingKey = randomBytes(32)
const listService = new HumanQueryService(fixture.sql, signingKey)
const boardService = new BoardService(fixture.sql, signingKey)
const projectService = new ProjectQueryService(fixture.sql, signingKey)
const listQuery = {
  model: "r4" as const,
  filter: null,
  search: null,
  sort: [{ field: "createdAt" as const, direction: "asc" as const }],
  includeArchived: false,
  page: { size: 100, cursor: null as string | null },
}
const boardQuery = {
  ...listQuery,
  workflowStateId: null as string | null,
  page: { size: 25, cursor: null as string | null },
}
const projectQuery = {
  filter: null,
  search: null,
  sort: [{ field: "createdAt" as const, direction: "asc" as const }],
  includeArchived: false,
  page: { size: 100, cursor: null as string | null },
}
const ErrorSchema = z.strictObject({ error: z.object({ code: z.string() }).loose() })

test("100000 authorized Work Items traverse exactly once through list changes", async () => {
  // Given
  const listIds = new Set<string>()
  let page = await listService.queryWorkItems(principal, "scale-query", listQuery)
  addUnique(listIds, page.items)
  await fixture.sql`update work_items set title='Changed',updated_at=clock_timestamp()
    where id='item-000001'`
  await fixture.sql`update entities set lifecycle='archived',archived_at=clock_timestamp()
    where id='item-000002'`

  // When
  while (page.nextCursor !== null) {
    page = await listService.queryWorkItems(principal, "scale-query", {
      ...listQuery,
      page: { size: 100, cursor: page.nextCursor },
    })
    addUnique(listIds, page.items)
  }

  // Then
  assert.equal(listIds.size, 100_000)
  assert.equal(page.completeness.matched, 100_000)
})

test("100000 authorized Work Items traverse exactly once through five changing board columns", async () => {
  // Given
  await fixture.sql`update work_items set title='Item 1' where id='item-000001'`
  await fixture.sql`update entities set lifecycle='active',archived_at=null where id='item-000002'`
  const boardIds = new Set<string>()
  const board = await boardService.query(principal, "scale-query", boardQuery)
  assert.deepEqual(
    board.columns.map((column) => column.total),
    [20_000, 20_000, 20_000, 20_000, 20_000],
  )
  for (const column of board.columns) addUnique(boardIds, column.cards)
  await fixture.sql`update work_items set title='Reordered' where id='item-000003'`
  await fixture.sql`update entities set lifecycle='archived',archived_at=clock_timestamp()
    where id='item-000004'`
  await fixture.sql`update work_item_pm set workflow_state_id=stable_r4_entity_id(
    'state','scale-query','all:completed') where work_item_id='item-000005'`

  // When
  for (const initialColumn of board.columns) {
    let cursor = initialColumn.nextCursor
    while (cursor !== null) {
      const continuation = await boardService.query(principal, "scale-query", {
        ...boardQuery,
        workflowStateId: initialColumn.state.id,
        page: { size: 25, cursor },
      })
      const column = continuation.columns[0]
      if (column === undefined) throw new TypeError("continued board column missing")
      addUnique(boardIds, column.cards)
      cursor = column.nextCursor
    }
  }

  // Then
  assert.equal(boardIds.size, 100_000)
})

test("100001 matches reject list and board before snapshot persistence", async () => {
  // Given
  await fixture.sql`update entities set lifecycle='active',archived_at=null where id='item-000004'`
  await seedWorkItems(1, 100_001)
  const before = await snapshotCount()

  // When
  await assert.rejects(
    listService.queryWorkItems(principal, "scale-query", listQuery),
    QueryBudgetExceededError,
  )
  await assert.rejects(
    boardService.query(principal, "scale-query", boardQuery),
    QueryBudgetExceededError,
  )
  await seedProjects(100_001)
  await assert.rejects(
    projectService.queryProjects(principal, "scale-query", projectQuery),
    QueryBudgetExceededError,
  )
  const server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-01-01T00:00:00.000Z",
    },
    [createR4HumanRouter(fixture.sql, signingKey)],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("server address missing")
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/human/v1/workspaces/scale-query/work-items/board`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(boardQuery),
    },
  )
  const error = ErrorSchema.parse(await response.json())
  const projectResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/human/v1/workspaces/scale-query/projects/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(projectQuery),
    },
  )
  const projectError = ErrorSchema.parse(await projectResponse.json())
  await new Promise<void>((resolve, reject) =>
    server.close((closeError) => (closeError === undefined ? resolve() : reject(closeError))),
  )

  // Then
  assert.equal(response.status, 507)
  assert.equal(error.error.code, "query_budget_exceeded")
  assert.equal(projectResponse.status, 507)
  assert.equal(projectError.error.code, "query_budget_exceeded")
  assert.equal(await snapshotCount(), before)
})

async function seedProjects(count: number): Promise<void> {
  await fixture.sql`insert into entities
      (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    select 'project-'||lpad(value::text,6,'0'),'scale-query','project',1,'owner',
      '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 millisecond',
      '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 millisecond'
    from generate_series(1,${count}::integer) value`
  await fixture.sql`insert into projects
      (id,workspace_id,name,slug,owner_id,state,health,priority,revision,created_at,updated_at)
    select id,workspace_id,'Project '||substring(id from 9),id,'owner','active','on_track',
      'none',current_revision,created_at,updated_at from entities
    where workspace_id='scale-query' and kind='project'`
  await fixture.sql`alter table entity_acl_policies disable trigger entity_policy_epoch`
  await fixture.sql`insert into entity_acl_policies select id,'inherit' from entities
    where workspace_id='scale-query' and kind='project'`
  await fixture.sql`alter table entity_acl_policies enable trigger entity_policy_epoch`
}

async function seedWorkItems(count: number, first = 1): Promise<void> {
  const last = first + count - 1
  await fixture.sql`alter table work_items disable trigger work_items_sync_pm`
  await fixture.sql`insert into work_items
      (id,workspace_id,space_id,title,state,accountable_owner_id,revision,created_at,updated_at)
    select 'item-'||lpad(value::text,6,'0'),'scale-query','all','Item '||value,'unstarted',
      'owner',1,'2026-01-01T00:00:00Z'::timestamptz + value * interval '1 millisecond',
      '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 millisecond'
    from generate_series(${first}::integer,${last}::integer) value`
  await fixture.sql`alter table work_items enable trigger work_items_sync_pm`
  await fixture.sql`insert into work_item_pm
      (work_item_id,workspace_id,space_id,sequence,workflow_state_id)
    select id,workspace_id,space_id,substring(id from 6)::bigint,
      stable_r4_entity_id('state',workspace_id,space_id||':'||
        (array['backlog','unstarted','started','completed','canceled'])[
          1 + substring(id from 6)::integer % 5])
    from work_items where workspace_id='scale-query' and substring(id from 6)::integer between ${first} and ${last}`
  await fixture.sql`insert into entities
      (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    select id,workspace_id,'work_item',space_id,revision,'owner',created_at,updated_at
    from work_items where workspace_id='scale-query' and substring(id from 6)::integer between ${first} and ${last}`
  await fixture.sql`alter table entity_acl_policies disable trigger entity_policy_epoch`
  await fixture.sql`insert into entity_acl_policies select id,'inherit' from entities
    where workspace_id='scale-query' and kind='work_item'
      and substring(id from 6)::integer between ${first} and ${last}`
  await fixture.sql`alter table entity_acl_policies enable trigger entity_policy_epoch`
  await fixture.sql`insert into entity_revisions
      (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    select w.id,1,'work-item.r4.v1',snapshot.value,'owner',w.created_at,
      encode(public.digest(convert_to(snapshot.value::text,'utf8'),'sha256'),'hex')
    from work_items w join work_item_pm pm on pm.work_item_id=w.id
    cross join lateral (select to_jsonb(w)||to_jsonb(pm)||jsonb_build_object(
      'labelIds','[]'::jsonb) value) snapshot
    where w.workspace_id='scale-query' and substring(w.id from 6)::integer between ${first} and ${last}`
}

function addUnique(ids: Set<string>, items: readonly { readonly id: string }[]): void {
  for (const item of items) {
    assert.equal(ids.has(item.id), false)
    ids.add(item.id)
  }
}

async function snapshotCount(): Promise<number> {
  const rows = await fixture.sql<{ readonly count: number }[]>`
    select count(*)::integer count from human_query_snapshots where workspace_id='scale-query'`
  return rows[0]?.count ?? 0
}
