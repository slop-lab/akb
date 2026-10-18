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
  await migrateDatabase(fixture.sql)
  await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "workspace",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
})

afterEach(async () => {
  await fixture.close()
})

test("migration registers legacy kinds and every feature permission atom", async () => {
  // Given / When
  const permissions = await fixture.sql<{ readonly permission: string }[]>`
    select permission from permission_atoms where permission in
      ('content.read','content.manage','run.delegate','run.inspect','knowledge.read',
       'knowledge.propose','knowledge.accept','review.read','review.decide',
       'automation.read','automation.manage','admin.integrations') order by permission`
  const kinds = await fixture.sql<{ readonly kind: string; readonly read_permission: string }[]>`
    select kind,read_permission from entity_kind_registry where kind in
      ('work_item','comment','thread','relation','project','space','workflow',
       'workflow_state','label','saved_view') order by kind`

  // Then
  assert.equal(permissions.length, 12)
  assert.deepEqual(
    [...kinds],
    [
      { kind: "comment", read_permission: "work.read" },
      { kind: "label", read_permission: "space.read" },
      { kind: "project", read_permission: "project.read" },
      { kind: "relation", read_permission: "work.read" },
      { kind: "saved_view", read_permission: "view.read" },
      { kind: "space", read_permission: "space.read" },
      { kind: "thread", read_permission: "work.read" },
      { kind: "workflow", read_permission: "space.read" },
      { kind: "workflow_state", read_permission: "space.read" },
      { kind: "work_item", read_permission: "work.read" },
    ],
  )
})

test("dependency ACL requires transitive parent access and invalidates authority epoch", async () => {
  // Given
  await seedEntity("parent", "work_item")
  await seedEntity("child", "comment")
  await fixture.sql`update entity_acl_policies set mode='restricted' where entity_id='parent'`
  const before = await authorityEpoch()

  // When
  await fixture.sql`insert into entity_access_dependencies values ('child','parent')`
  const denied = await fixture.sql`select entity_access_allowed(
    'workspace','child','owner','work.read') allowed`
  await fixture.sql`insert into entity_acl_allowances
    (entity_id,principal_id,permission) values ('parent','owner','work.read')`
  const allowed = await fixture.sql`select entity_access_allowed(
    'workspace','child','owner','work.read') allowed`

  // Then
  assert.deepEqual([...denied], [{ allowed: false }])
  assert.deepEqual([...allowed], [{ allowed: true }])
  assert.equal((await authorityEpoch()) > before, true)
})

test("dependency graph rejects cross-workspace links and cycles", async () => {
  // Given
  await fixture.sql`insert into workspaces (id,name) values ('other','Other')`
  await seedEntity("one", "work_item")
  await seedEntity("two", "comment")
  await fixture.sql`insert into entities
    (id,workspace_id,kind,current_revision,created_at,updated_at)
    values ('foreign','other','work_item',1,now(),now())`
  await fixture.sql`insert into entity_acl_policies values ('foreign','inherit')`
  await fixture.sql`insert into entity_access_dependencies values ('one','two')`

  // When / Then
  await assert.rejects(
    fixture.sql`insert into entity_access_dependencies values ('two','one')`,
    /cycle/i,
  )
  await assert.rejects(
    fixture.sql`insert into entity_access_dependencies values ('one','foreign')`,
    /workspace/i,
  )
})

test("dependency graph rejects concurrent inverse edges", async () => {
  // Given
  await seedEntity("one", "work_item")
  await seedEntity("two", "comment")
  const firstClient = fixture.connect()
  const secondClient = fixture.connect()
  const firstInserted = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  let firstTransaction: Promise<unknown> | undefined
  let secondTransaction: Promise<unknown> | undefined

  try {
    firstTransaction = firstClient.begin(async (transaction) => {
      await transaction`insert into entity_access_dependencies values ('one','two')`
      firstInserted.resolve()
      await releaseFirst.promise
    })
    await firstInserted.promise
    secondTransaction = secondClient.begin(async (transaction) => {
      await transaction`select set_config('application_name','foundation-cycle-race',true)`
      await transaction`insert into entity_access_dependencies values ('two','one')`
    })
    await waitForLock("foundation-cycle-race")

    // When
    releaseFirst.resolve()
    await firstTransaction

    // Then
    await assert.rejects(secondTransaction, /cycle/i)
  } finally {
    releaseFirst.resolve()
    await Promise.allSettled([firstTransaction, secondTransaction])
    await Promise.all([firstClient.end(), secondClient.end()])
  }
})

async function seedEntity(id: string, kind: string): Promise<void> {
  await fixture.sql`insert into entities
    (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    values (${id},'workspace',${kind},1,'owner',now(),now())`
  await fixture.sql`insert into entity_acl_policies values (${id},'inherit')`
}

async function authorityEpoch(): Promise<number> {
  const rows = await fixture.sql<{ readonly epoch: string }[]>`
    select epoch::text from workspace_authority_epochs where workspace_id='workspace'`
  const value = rows[0]?.epoch
  if (value === undefined) throw new TypeError("authority epoch is missing")
  return Number(value)
}

async function waitForLock(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await fixture.sql<{ readonly waiting: boolean }[]>`
      select exists (
        select 1 from pg_stat_activity where application_name=${applicationName}
          and wait_event_type='Lock'
      ) waiting`
    if (rows[0]?.waiting === true) return
  }
  throw new TypeError("concurrent dependency insert did not wait for a lock")
}
