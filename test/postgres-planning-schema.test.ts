import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import type { Sql } from "postgres"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { createUnmigratedPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createUnmigratedPostgresTestFixture()
await migrateDatabase(database.sql)
after(database.close)
beforeEach(async () => {
  await database.sql`truncate delivery_inbox, delivery_inbox_v1, workspaces, work_items,
    workspace_event_sequences cascade`
})

test("cycle storage permits only one active cycle per Space", async () => {
  // Given
  await seedProject(database.sql)
  await insertCycle(database.sql, "cycle-one", 1, "active")

  // When / Then
  await assert.rejects(insertCycle(database.sql, "cycle-two", 2, "active"), {
    code: "23505",
  })
})

test("planning assignments reject a Cycle from another Space", async () => {
  // Given
  await seedProject(database.sql)
  await new SpaceAdmin(database.sql).create({
    workspaceId: "w",
    spaceId: "other",
    spaceName: "Other",
    visibility: "public",
  })
  await insertCycle(database.sql, "other-cycle", 1, "upcoming", "other")
  await seedWork(database.sql)

  // When / Then
  await assert.rejects(
    database.sql`insert into work_item_planning
      (work_item_id,workspace_id,space_id,project_id,estimate,cycle_id,revision,updated_at)
      values ('work','w','delivery','project',3,'other-cycle',1,clock_timestamp())`,
    /cycle must belong to work space/,
  )
})

test("published metric snapshots and template revisions are immutable and exactly pinned", async () => {
  // Given
  await seedProject(database.sql)
  await insertCycle(database.sql, "cycle-one", 1, "completed")
  await database.sql`insert into cycle_metric_snapshots
    (cycle_id,revision,captured_at,committed_count,added_count,removed_count,completed_count,
     committed_estimate,completed_estimate,carry_over_count)
    values ('cycle-one',1,clock_timestamp(),2,1,0,1,5,3,1)`
  await insertEntity(database.sql, "template", "planning_template", null)
  await database.sql`insert into planning_templates
    (id,workspace_id,name,kind,current_revision,created_by,created_at,updated_at)
    values ('template','w','Default','work',1,'owner',clock_timestamp(),clock_timestamp())`
  await database.sql`insert into planning_template_revisions
    (template_id,revision,content,actor_id,created_at)
    values ('template',1,'{}','owner',clock_timestamp())`

  // When / Then
  await assert.rejects(
    database.sql`update cycle_metric_snapshots set completed_count=2 where cycle_id='cycle-one'`,
    /canonical record is immutable/,
  )
  await insertEntity(database.sql, "application", "template_application", null)
  await assert.rejects(
    database.sql`insert into planning_template_applications
      (id,workspace_id,target_entity_id,target_kind,template_id,template_revision,applied_at)
      values ('application','w','project','project','template',2,clock_timestamp())`,
    { code: "23503" },
  )
})

test("notification inbox deduplicates events and respects disabled preferences", async () => {
  // Given
  await seedProject(database.sql)
  await database.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    values ('project',1,'test','{}','owner',clock_timestamp(),repeat('0',64))`
  await database.sql`insert into entity_event_sequences values ('w',1)`
  await database.sql`insert into entity_events_v1
    (id,workspace_id,sequence,event_type,subject_kind,subject_id,subject_revision,
     occurred_at,actor_id,data)
    values ('event','w',1,'entity.created','project','project',1,clock_timestamp(),'owner','{}')`
  await insertEntity(database.sql, "settings", "notification_settings", null)
  await database.sql`insert into notification_settings values ('settings','w','owner',1)`
  await database.sql`insert into notification_preferences
    (settings_id,workspace_id,principal_id,event_type,in_app)
    values ('settings','w','owner','entity.created',false)`

  // When
  const inserted = await database.sql`insert into notifications
    (workspace_id,recipient_id,source_event_id,source_entity_id,deduplication_key,payload)
    select 'w','owner','event','project','event:owner','{}'
    where coalesce((select in_app from notification_preferences where workspace_id='w'
      and principal_id='owner' and event_type='entity.created'),true)
    on conflict do nothing returning id`

  // Then
  assert.equal(inserted.length, 0)
})

async function seedProject(sql: Sql): Promise<void> {
  await new IdentityAdmin(sql).bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await new SpaceAdmin(sql).create({
    workspaceId: "w",
    spaceId: "delivery",
    spaceName: "Delivery",
    visibility: "public",
  })
  await insertEntity(sql, "project", "project", null)
  await sql`insert into projects
    (id,workspace_id,name,slug,owner_id,state,health,priority,revision,created_at,updated_at)
    values ('project','w','Project','project','owner','active','on_track','none',1,
      clock_timestamp(),clock_timestamp())`
  await sql`insert into project_spaces values ('project','w','delivery')`
}

async function seedWork(sql: Sql): Promise<void> {
  await sql`insert into work_items
    (id,workspace_id,space_id,title,state,accountable_owner_id,revision,created_at,updated_at)
    values ('work','w','delivery','Work','unstarted','owner',1,clock_timestamp(),clock_timestamp())`
  await sql`update work_item_pm set project_id='project' where work_item_id='work'`
}

async function insertCycle(
  sql: Sql,
  id: string,
  sequence: number,
  status: "upcoming" | "active" | "completed",
  spaceId = "delivery",
): Promise<void> {
  await insertEntity(sql, id, "cycle", spaceId)
  await sql`insert into cycles
    (id,workspace_id,space_id,sequence,name,start_date,end_date,status,rollover_policy,
     revision,created_at,updated_at)
    values (${id},'w',${spaceId},${sequence},${id},'2026-10-01','2026-10-31',${status},
      'reviewed',1,clock_timestamp(),clock_timestamp())`
}

async function insertEntity(
  sql: Sql,
  id: string,
  kind: string,
  spaceId: string | null,
): Promise<void> {
  await sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    values (${id},'w',${kind},${spaceId},1,'owner',clock_timestamp(),clock_timestamp())`
  await sql`insert into entity_acl_policies values (${id},'inherit')`
}
