import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
})

afterEach(async () => {
  await fixture.close()
})

test("a query snapshot persists the 100000-member boundary", async () => {
  // Given
  await migrateDatabase(fixture.sql)
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "scale",
    workspaceName: "Scale",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await fixture.sql`insert into entities
      (id, workspace_id, kind, current_revision, created_at, updated_at)
    select 'scale-' || value::text, 'scale', 'work_item', 1, now(), now()
    from generate_series(1, 100000) as value`
  const snapshots = await fixture.sql<{ readonly id: string }[]>`
    insert into human_query_snapshots
      (workspace_id, principal_id, credential_id, query_hash, sort_hash, authority_hash, matched,
       expires_at)
    values
      ('scale', 'owner', ${issued.credentialId}, repeat('a', 64), repeat('b', 64), repeat('c', 64),
       100000, clock_timestamp() + interval '10 minutes')
    returning id::text`
  const snapshotId = snapshots[0]?.id
  if (snapshotId === undefined) throw new Error("missing scale snapshot")

  // When
  await fixture.sql`insert into human_query_snapshot_items
      (snapshot_id, ordinal, entity_id, source_revision)
    select ${snapshotId}::uuid, value, 'scale-' || value::text, 1
    from generate_series(1, 100000) as value`

  // Then
  const counts = await fixture.sql<{ readonly count: number }[]>`
    select count(*)::integer as count from human_query_snapshot_items
    where snapshot_id = ${snapshotId}::uuid`
  assert.deepEqual([...counts], [{ count: 100000 }])
  await assert.rejects(async () => {
    await fixture.sql`insert into human_query_snapshot_items
        (snapshot_id, ordinal, entity_id, source_revision)
        values (${snapshotId}::uuid, 100001, 'scale-1', 1)`
  }, /human_query_snapshot_items_ordinal_check/)
})
