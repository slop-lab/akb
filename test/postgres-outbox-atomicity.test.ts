import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { OutboxRepository } from "../src/outbox/repository.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { AuthorizedPostgresWorkItemStore } from "../src/work-items/authorized-postgres-store.ts"
import {
  actorId,
  eventId,
  humanPrincipalId,
  idempotencyKey,
  revision,
  workItemId,
  workItemTitle,
  workspaceId,
} from "../src/work-items/identifiers.ts"
import {
  createPostgresTestFixture,
  createUnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
after(database.close)
beforeEach(database.reset)

const scope = { workspaceId: "atomic-workspace", destinationId: "database-a" }

async function setup() {
  const issued = await new IdentityAdmin(database.sql).bootstrapWorkspace({
    workspaceId: scope.workspaceId,
    workspaceName: "Atomic Workspace",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(database.sql, issued.token)
  if (principal === undefined) throw new Error("fixture authentication failed")
  const store = new AuthorizedPostgresWorkItemStore(database.sql, principal, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => "2026-10-09T12:00:00.000Z",
  })
  return { store, repository: new OutboxRepository(database.sql) }
}

function createCommand(key: string) {
  return {
    workspaceId: workspaceId(scope.workspaceId),
    title: workItemTitle("Atomic item"),
    accountableOwnerId: humanPrincipalId("human-one"),
    actorId: actorId("human-one"),
    idempotencyKey: idempotencyKey(key),
  }
}

async function mutationCounts() {
  const rows = await database.sql<
    {
      readonly items: number
      readonly revisions: number
      readonly events: number
      readonly idempotency: number
      readonly outboxEvents: number
      readonly jobs: number
      readonly sequences: number
    }[]
  >`select
    (select count(*)::integer from work_items) as items,
    (select count(*)::integer from work_item_revisions) as revisions,
    (select count(*)::integer from domain_events) as events,
    (select count(*)::integer from work_item_idempotency) as idempotency,
    (select count(*)::integer from outbox_events) as "outboxEvents",
    (select count(*)::integer from outbox_jobs) as jobs,
    (select count(*)::integer from workspace_event_sequences) as sequences`
  const counts = rows[0]
  if (counts === undefined) throw new Error("missing mutation counts")
  return { ...counts }
}

async function installRejectingJobTrigger(): Promise<() => Promise<void>> {
  await database.sql`create function reject_test_outbox_job() returns trigger language plpgsql as $$
    begin raise exception 'forced outbox job failure'; end $$`
  await database.sql`create trigger reject_test_outbox_job before insert on outbox_jobs
    for each row execute function reject_test_outbox_job()`
  return async () => {
    await database.sql`drop trigger reject_test_outbox_job on outbox_jobs`
    await database.sql`drop function reject_test_outbox_job()`
  }
}

test("failed create fanout rolls back every mutation record and sequence", async () => {
  const fixture = await setup()
  await fixture.repository.register(scope)
  const removeTrigger = await installRejectingJobTrigger()

  try {
    await assert.rejects(fixture.store.create(createCommand("failed-create")), /forced outbox job/)
  } finally {
    await removeTrigger()
  }

  assert.deepEqual(await mutationCounts(), {
    items: 0,
    revisions: 0,
    events: 0,
    idempotency: 0,
    outboxEvents: 0,
    jobs: 0,
    sequences: 0,
  })
})

test("failed patch fanout preserves the current revision and all append-only counts", async () => {
  const fixture = await setup()
  await fixture.repository.register(scope)
  const created = await fixture.store.create(createCommand("patch-base"))
  if (created.kind !== "created") throw new Error("fixture create failed")
  const before = await mutationCounts()
  const removeTrigger = await installRejectingJobTrigger()

  try {
    await assert.rejects(
      fixture.store.patch({
        id: created.item.id,
        actorId: actorId("human-one"),
        baseRevision: revision(1),
        title: workItemTitle("Rejected patch"),
      }),
      /forced outbox job/,
    )
  } finally {
    await removeTrigger()
  }

  assert.deepEqual(await mutationCounts(), before)
  const rows = await database.sql<{ readonly revision: number; readonly title: string }[]>`
    select revision::integer as revision, title from work_items where id = ${created.item.id}`
  assert.deepEqual({ ...rows[0] }, { revision: 1, title: "Atomic item" })
})

test("create replay and no-op patch append no outbox event or job", async () => {
  const fixture = await setup()
  await fixture.repository.register(scope)
  const command = createCommand("replay")
  const created = await fixture.store.create(command)
  if (created.kind !== "created") throw new Error("fixture create failed")
  const before = await mutationCounts()

  const replayed = await fixture.store.create(command)
  const unchanged = await fixture.store.patch({
    id: created.item.id,
    actorId: actorId("human-one"),
    baseRevision: revision(1),
    title: created.item.title,
  })

  assert.equal(replayed.kind, "replayed")
  assert.equal(unchanged.kind, "unchanged")
  assert.deepEqual(await mutationCounts(), before)
})

test("migration 003 does not enqueue events written under legacy migrations", async () => {
  const legacy = await createUnmigratedPostgresTestFixture()
  const directory = await mkdtemp(join(tmpdir(), "afw-legacy-outbox-"))
  try {
    for (const name of ["001_work_item_persistence.sql", "002_workspace_identity.sql"]) {
      await writeFile(join(directory, name), await readFile(join("migrations", name)))
    }
    await migrateDatabase(legacy.sql, directory)
    await legacy.sql`insert into workspace_event_sequences values ('legacy-workspace', 1)`
    await legacy.sql`insert into work_items values
      ('legacy-item', 'legacy-workspace', 'Legacy item', 'unstarted', 'legacy-owner', 1, now(), now())`
    await legacy.sql`insert into work_item_revisions values
      ('legacy-item', 'legacy-workspace', 'Legacy item', 'unstarted', 'legacy-owner', 1, now(), now())`
    await legacy.sql`insert into domain_events values
      ('legacy-event', 'legacy-workspace', 1, 'work_item.created', now(), 'legacy-owner',
       'legacy-item', 1, null)`

    await migrateDatabase(legacy.sql)

    const rows = await legacy.sql<{ readonly events: number; readonly jobs: number }[]>`select
      (select count(*)::integer from outbox_events) as events,
      (select count(*)::integer from outbox_jobs) as jobs`
    assert.deepEqual({ ...rows[0] }, { events: 0, jobs: 0 })
  } finally {
    await legacy.close()
    await rm(directory, { recursive: true })
  }
})
