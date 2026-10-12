import assert from "node:assert/strict"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { test } from "node:test"
import { migrateDatabase, readMigrationCatalog } from "../src/postgres/migrate.ts"
import { createUnmigratedPostgresTestFixture } from "./postgres-fixture.ts"

test("migration 010 invalidates only snapshots containing legacy Work revisions", async (context) => {
  // Given
  const database = await createUnmigratedPostgresTestFixture()
  const directory = await mkdtemp(join(tmpdir(), "afw-legacy-projection-migrations-"))
  context.after(database.close)
  context.after(() => rm(directory, { recursive: true }))
  await migrateThrough(database.sql, directory, 9)
  await database.sql`insert into workspaces (id,name) values ('workspace','Workspace')`
  await database.sql`insert into principals (id,workspace_id,display_name,kind)
    values ('owner','workspace','Owner','human')`
  await database.sql`insert into workspace_memberships (workspace_id,principal_id,role)
    values ('workspace','owner','owner')`
  await database.sql`insert into principal_credentials
    (id,workspace_id,principal_id,token_hash,expires_at)
    values ('credential','workspace','owner',decode(repeat('00',32),'hex'),'2030-01-01')`
  await database.sql`insert into spaces (workspace_id,id,name,visibility)
    values ('workspace','space','Space','public')`
  await database.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_at,updated_at) values
    ('legacy','workspace','work_item','space',1,now(),now()),
    ('native','workspace','work_item','space',1,now(),now())`
  await database.sql`insert into entity_acl_policies values ('legacy','inherit'),('native','inherit')`
  await database.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,created_at,digest) values
    ('legacy',1,'work-item.legacy.v1','{}',now(),repeat('a',64)),
    ('native',1,'work-item.r4.v1','{}',now(),repeat('b',64))`
  const snapshots = {
    legacy: "00000000-0000-4000-8000-000000000001",
    native: "00000000-0000-4000-8000-000000000002",
    mixed: "00000000-0000-4000-8000-000000000003",
  } as const
  for (const id of Object.values(snapshots)) {
    await database.sql`insert into human_query_snapshots
      (id,workspace_id,principal_id,credential_id,query_hash,sort_hash,authority_hash,matched,expires_at)
      values (${id},'workspace','owner','credential',repeat('a',64),repeat('b',64),repeat('c',64),
        1,clock_timestamp()+interval '10 minutes')`
  }
  await database.sql`insert into human_query_snapshot_items
    (snapshot_id,ordinal,entity_id,source_revision) values
    (${snapshots.legacy},1,'legacy',1),
    (${snapshots.native},1,'native',1),
    (${snapshots.mixed},1,'legacy',1),
    (${snapshots.mixed},2,'native',1)`
  const revisionsBefore =
    await database.sql`select * from entity_revisions order by entity_id,revision`

  // When
  await migrateDatabase(database.sql)

  // Then
  assert.deepEqual(
    [...(await database.sql`select id::text from human_query_snapshots order by id`)],
    [{ id: snapshots.native }],
  )
  assert.deepEqual(
    [
      ...(await database.sql`select snapshot_id::text,legacy_work_pm_projection
      from human_query_snapshot_items order by snapshot_id,ordinal`),
    ],
    [{ snapshot_id: snapshots.native, legacy_work_pm_projection: null }],
  )
  await assert.rejects(
    database.sql`update human_query_snapshot_items set legacy_work_pm_projection='[]'::jsonb
      where snapshot_id=${snapshots.native}`,
    /legacy_work_pm_projection_check/,
  )
  await assert.rejects(
    database.sql`update human_query_snapshot_items set legacy_work_pm_projection='null'::jsonb
      where snapshot_id=${snapshots.native}`,
    /legacy_work_pm_projection_check/,
  )
  await assert.rejects(
    database.sql`update human_query_snapshot_items set legacy_work_pm_projection='{}'::jsonb
      where snapshot_id=${snapshots.native}`,
    /legacy_work_pm_projection_check/,
  )
  await assert.rejects(
    database.sql`update human_query_snapshot_items
      set legacy_work_pm_projection='{"_schema":"wrong"}'::jsonb
      where snapshot_id=${snapshots.native}`,
    /legacy_work_pm_projection_check/,
  )
  await database.sql`update human_query_snapshot_items
    set legacy_work_pm_projection='{"_schema":"legacy-work-pm-query.v1"}'::jsonb
    where snapshot_id=${snapshots.native}`
  assert.deepEqual(
    [...(await database.sql`select * from entity_revisions order by entity_id,revision`)],
    [...revisionsBefore],
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
