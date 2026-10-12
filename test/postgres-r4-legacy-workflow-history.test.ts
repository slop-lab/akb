import assert from "node:assert/strict"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { test } from "node:test"
import { BoardService } from "../src/human-query/board-service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { migrateDatabase, readMigrationCatalog } from "../src/postgres/migrate.ts"
import { createUnmigratedPostgresTestFixture } from "./postgres-fixture.ts"

test("migration 009 reconstructs deterministic pre-007 workflow history and older boards", async (context) => {
  // Given
  const database = await createUnmigratedPostgresTestFixture()
  const directory = await mkdtemp(join(tmpdir(), "afw-legacy-workflow-migrations-"))
  context.after(database.close)
  context.after(() => rm(directory, { recursive: true }))
  await migrateThrough(database.sql, directory, 4)
  await database.sql`insert into workspaces (id,name) values ('legacy','Legacy')`
  await database.sql`insert into principals (id,workspace_id,display_name,kind)
    values ('owner','legacy','Owner','human')`
  await database.sql`insert into workspace_memberships (workspace_id,principal_id,role)
    values ('legacy','owner','owner')`
  await database.sql`insert into spaces (workspace_id,id,name,visibility,created_at,updated_at) values
    ('legacy','old','Old','public','2026-01-02T03:04:05Z','2026-01-02T03:04:05Z'),
    ('legacy','changed','Changed','public','2026-02-03T04:05:06Z','2026-02-03T04:05:06Z')`
  await migrateThrough(database.sql, directory, 8)
  await database.sql`insert into membership_permissions (workspace_id,principal_id,permission)
    values ('legacy','owner','work.read'),('legacy','owner','space.read')`

  const [ids] = await database.sql<
    {
      readonly workflow: string
      readonly started: string
      readonly completed: string
      readonly replacement: string
    }[]
  >`select stable_r4_entity_id('workflow','legacy','changed') workflow,
      stable_r4_entity_id('state','legacy','changed:started') started,
      stable_r4_entity_id('state','legacy','changed:completed') completed,
      stable_r4_entity_id('state','legacy','changed:replacement') replacement`
  if (ids === undefined) throw new TypeError("stable IDs missing")
  await database.sql`insert into entities
      (id,workspace_id,kind,scope_space_id,current_revision,created_at,updated_at)
    values (${ids.replacement},'legacy','workflow_state','changed',1,
      '2026-02-03T04:05:06Z','2026-02-03T04:05:06Z')`
  await database.sql`insert into entity_acl_policies values (${ids.replacement},'inherit')`
  await database.sql`insert into workflow_states
      (id,workflow_id,workspace_id,space_id,name,category,color,position,is_default,active,revision)
    values (${ids.replacement},${ids.workflow},'legacy','changed','Replacement','completed',
      '#000000',10,false,true,1)`

  await database.sql`update workflows set name='Renamed',revision=2 where id=${ids.workflow}`
  await database.sql`update entities set current_revision=2 where id=${ids.workflow}`
  await insertRevision(database.sql, ids.workflow, 2, "workflow.r4.v1", {
    id: ids.workflow,
    name: "Renamed",
    active: true,
  })
  await database.sql`update workflow_states set name='In flight',color='#123456',position=9,
    revision=2 where id=${ids.started}`
  await database.sql`update entities set current_revision=2 where id=${ids.started}`
  await insertRevision(database.sql, ids.started, 2, "workflow-state.r4.v1", {
    id: ids.started,
    workflowId: ids.workflow,
    name: "In flight",
    category: "started",
    color: "#123456",
    position: 9,
    isDefault: false,
    active: true,
  })
  await database.sql`update workflow_states set active=false,revision=2 where id=${ids.completed}`
  await database.sql`update entities set current_revision=2,lifecycle='archived',
    archived_at='2026-03-04T05:06:07Z' where id=${ids.completed}`
  await insertRevision(database.sql, ids.completed, 2, "workflow-state.r4.v1", {
    id: ids.completed,
    workflowId: ids.workflow,
    name: "Completed",
    category: "completed",
    color: "#22C55E",
    position: 3,
    isDefault: false,
    active: false,
  })
  const laterBefore =
    await database.sql`select entity_id,revision,schema_version,canonical_snapshot,
    actor_id,cause_event_id,created_at,digest from entity_revisions where revision>1 order by entity_id`
  const eventsBefore = await database.sql`select count(*)::integer count from entity_events_v1`

  // When
  await migrateDatabase(database.sql)

  // Then
  const reconstructed = await database.sql<
    {
      readonly entity_id: string
      readonly schema_version: string
      readonly canonical_snapshot: unknown
      readonly actor_id: string | null
      readonly cause_event_id: string | null
      readonly created_at_matches: boolean
    }[]
  >`select r.entity_id,r.schema_version,r.canonical_snapshot,
      r.actor_id,r.cause_event_id,r.created_at=e.created_at created_at_matches
    from entity_revisions r join entities e on e.id=r.entity_id
    where r.revision=1 and e.workspace_id='legacy' and e.kind in ('workflow','workflow_state')
    order by r.entity_id`
  assert.equal(reconstructed.length, 12)
  assert.equal(
    reconstructed.every((row) => row.actor_id === null),
    true,
  )
  assert.equal(
    reconstructed.every((row) => row.cause_event_id === null),
    true,
  )
  assert.equal(
    reconstructed.every((row) => row.created_at_matches === true),
    true,
  )
  const workflowR1 = reconstructed.find((row) => row.entity_id === ids.workflow)
  assert.deepEqual(workflowR1?.canonical_snapshot, {
    id: ids.workflow,
    name: "Default",
    active: true,
  })
  const startedR1 = reconstructed.find((row) => row.entity_id === ids.started)
  assert.deepEqual(startedR1?.canonical_snapshot, {
    id: ids.started,
    workflowId: ids.workflow,
    name: "Started",
    category: "started",
    color: "#3B82F6",
    position: 2,
    isDefault: false,
    active: true,
  })
  assert.deepEqual(
    await database.sql`select entity_id,revision,schema_version,canonical_snapshot,actor_id,
      cause_event_id,created_at,digest from entity_revisions where revision>1 order by entity_id`,
    laterBefore,
  )
  assert.equal(
    (
      await database.sql<{ readonly count: number }[]>`select count(*)::integer count
      from entity_revisions where entity_id=${ids.replacement}`
    )[0]?.count,
    0,
  )
  assert.deepEqual(
    await database.sql`select count(*)::integer count from entity_events_v1`,
    eventsBefore,
  )

  const issued = await new IdentityAdmin(database.sql).issueToken({
    workspaceId: "legacy",
    principalId: "owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(database.sql, issued.token)
  if (principal === undefined) throw new TypeError("fixture authentication failed")
  const [access] = await database.sql`select
    entity_access_allowed('legacy',stable_r4_entity_id('state','legacy','old:backlog'),'owner','space.read') state,
    entity_access_allowed('legacy',stable_space_entity_id('legacy','old'),'owner','space.read') space`
  assert.deepEqual(access, { state: true, space: true })
  const board = await new BoardService(database.sql, Buffer.alloc(32, 9)).query(
    principal,
    "legacy",
    {
      model: "r4",
      filter: { op: "eq", field: "spaceId", value: "old" },
      search: null,
      sort: [{ field: "title", direction: "asc" }],
      includeArchived: false,
      workflowStateId: null,
      page: { size: 10, cursor: null },
    },
  )
  assert.deepEqual(
    board.columns.map(({ state }) => [state.name, state.category, state.position, state.isDefault]),
    [
      ["Backlog", "backlog", 0, false],
      ["Unstarted", "unstarted", 1, true],
      ["Started", "started", 2, false],
      ["Completed", "completed", 3, false],
      ["Canceled", "canceled", 4, false],
    ],
  )
})

async function migrateThrough(
  sql: Parameters<typeof migrateDatabase>[0],
  directory: string,
  count: number,
): Promise<void> {
  await rm(directory, { recursive: true })
  await import("node:fs/promises").then(({ mkdir }) => mkdir(directory))
  for (const migration of (await readMigrationCatalog()).slice(0, count)) {
    await cp(resolve("migrations", migration.version), join(directory, basename(migration.version)))
  }
  await migrateDatabase(sql, directory)
}

async function insertRevision(
  sql: Parameters<typeof migrateDatabase>[0],
  entityId: string,
  revision: number,
  schemaVersion: string,
  snapshot: Readonly<Record<string, string | number | boolean>>,
): Promise<void> {
  await sql`insert into entity_revisions
      (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    values (${entityId},${revision},${schemaVersion},${sql.json(snapshot)},'owner',clock_timestamp(),
      encode(public.digest(convert_to(${JSON.stringify(snapshot)}::jsonb::text,'utf8'),'sha256'),'hex'))`
}
