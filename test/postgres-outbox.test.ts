import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { after, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { OutboxRepository } from "../src/outbox/repository.ts"
import { runDatabaseInboxWorker } from "../src/outbox/worker.ts"
import { AuthorizedPostgresWorkItemStore } from "../src/work-items/authorized-postgres-store.ts"
import {
  actorId,
  eventId,
  humanPrincipalId,
  idempotencyKey,
  workItemId,
  workItemTitle,
  workspaceId,
} from "../src/work-items/identifiers.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
after(database.close)
beforeEach(database.reset)

async function setup() {
  const issued = await new IdentityAdmin(database.sql).bootstrapWorkspace({
    workspaceId: "outbox-workspace",
    workspaceName: "Outbox Workspace",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(database.sql, issued.token)
  if (principal === undefined) throw new Error("fixture authentication failed")
  let clock = 0
  const store = new AuthorizedPostgresWorkItemStore(database.sql, principal, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, clock++)).toISOString(),
  })
  return { store, repository: new OutboxRepository(database.sql) }
}

async function createItem(store: AuthorizedPostgresWorkItemStore, key: string) {
  return store.create({
    workspaceId: workspaceId("outbox-workspace"),
    title: workItemTitle(`Item ${key}`),
    accountableOwnerId: humanPrincipalId("human-one"),
    actorId: actorId("human-one"),
    idempotencyKey: idempotencyKey(key),
  })
}

const scope = { workspaceId: "outbox-workspace", destinationId: "database-a" } as const

test("destination cutoff excludes history and trigger enqueues later events once", async () => {
  // Given
  const fixture = await setup()
  const historical = await createItem(fixture.store, "historical")
  assert.equal(historical.kind, "created")

  // When
  const cutoff = await fixture.repository.register(scope)
  const current = await createItem(fixture.store, "current")
  const replay = await createItem(fixture.store, "current")

  // Then
  assert.equal(cutoff, 1)
  assert.equal(current.kind, "created")
  assert.equal(replay.kind, "replayed")
  const jobs = await database.sql<{ readonly sequence: number }[]>`
    select sequence::integer as sequence from outbox_jobs order by sequence`
  assert.deepEqual(
    jobs.map((job) => job.sequence),
    [2],
  )
})

test("a locked head prevents a second claimer from leapfrogging", async () => {
  // Given
  const fixture = await setup()
  await fixture.repository.register(scope)
  await createItem(fixture.store, "first")
  await createItem(fixture.store, "second")

  // When
  const first = await fixture.repository.claim(scope)
  const second = await fixture.repository.claim(scope)

  // Then
  assert.equal(first?.sequence, 1)
  assert.equal(second, undefined)
})

test("expired lease fencing rejects stale acknowledgement and inbox delivery deduplicates", async () => {
  // Given
  const fixture = await setup()
  await fixture.repository.register(scope)
  await createItem(fixture.store, "once")
  const first = await fixture.repository.claim(scope)
  if (first === undefined) throw new Error("missing first claim")
  await fixture.repository.deliverToInbox(first)
  await database.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second'`

  // When
  const second = await fixture.repository.claim(scope)
  if (second === undefined) throw new Error("missing reclaimed delivery")
  const stale = await fixture.repository.acknowledge(first)
  await fixture.repository.deliverToInbox(second)
  const acknowledged = await fixture.repository.acknowledge(second)

  // Then
  assert.equal(stale, false)
  assert.equal(acknowledged, true)
  const rows = await database.sql<{ readonly count: number }[]>`
    select count(*)::integer as count from delivery_inbox`
  assert.equal(rows[0]?.count, 1)
})

test("bounded drain delivers ordered events into the durable inbox", async () => {
  // Given
  const fixture = await setup()
  await fixture.repository.register(scope)
  await createItem(fixture.store, "one")
  await createItem(fixture.store, "two")

  // When
  const summary = await runDatabaseInboxWorker(fixture.repository, scope, { drain: true })

  // Then
  assert.deepEqual(summary, { claimed: 2, delivered: 2, failed: 0 })
  const rows = await database.sql<{ readonly sequence: number }[]>`
    select sequence::integer as sequence from delivery_inbox order by sequence`
  assert.deepEqual(
    rows.map((row) => row.sequence),
    [1, 2],
  )
})

test("maximum failures dead-letter the head and explicit retry makes it claimable", async () => {
  // Given
  const fixture = await setup()
  await fixture.repository.register(scope)
  await createItem(fixture.store, "dead")

  // When
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const delivery = await fixture.repository.claim(scope)
    if (delivery === undefined) throw new Error(`missing claim ${attempt}`)
    assert.equal(await fixture.repository.fail(delivery, "expected sink failure"), true)
    await database.sql`update outbox_jobs set available_at = clock_timestamp()`
  }
  const deadRows = await database.sql<{ readonly job_id: string; readonly state: string }[]>`
    select job_id, state from outbox_jobs`
  const dead = deadRows[0]
  if (dead === undefined) throw new Error("missing dead-letter job")
  const blocked = await fixture.repository.claim(scope)
  const retried = await fixture.repository.retryDead(scope, dead.job_id)
  const reclaimed = await fixture.repository.claim(scope)

  // Then
  assert.equal(dead.state, "dead_letter")
  assert.equal(blocked, undefined)
  assert.equal(retried, true)
  assert.equal(reclaimed?.attempts, 1)
})

test("killed worker leaves an expired lease that a restarted worker delivers once", async () => {
  // Given
  const fixture = await setup()
  await fixture.repository.register(scope)
  await createItem(fixture.store, "crash")
  const schemaRows = await database.sql<{ readonly schema: string }[]>`
    select current_schema() as schema`
  const schema = schemaRows[0]?.schema
  const { DATABASE_URL: baseUrl } = process.env
  if (schema === undefined || baseUrl === undefined) throw new Error("missing subprocess database")
  const workerScript = `
    import { createPostgresClient, databaseSchemaName } from "./src/postgres/client.ts";
    import { OutboxRepository } from "./src/outbox/repository.ts";
    import { runDatabaseInboxWorker } from "./src/outbox/worker.ts";
    const sql = createPostgresClient(process.env.DATABASE_URL, {
      schema: databaseSchemaName(process.env.TEST_SCHEMA),
    });
    try {
      await runDatabaseInboxWorker(new OutboxRepository(sql),
        { workspaceId: "outbox-workspace", destinationId: "database-a" }, { drain: false });
    } finally { await sql.end({ timeout: 1 }); }
  `
  const blocker = database.connect()
  await database.sql`create function test_wait_inbox() returns trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(987654321); return new; end $$`
  await database.sql`create trigger test_wait_inbox before insert on delivery_inbox
    for each row execute function test_wait_inbox()`
  await blocker`select pg_advisory_lock(987654321)`

  // When
  const child = spawn(process.execPath, ["--input-type=module", "--eval", workerScript], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: baseUrl, TEST_SCHEMA: schema },
    stdio: "ignore",
  })
  let leaseObserved = false
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = await database.sql<{ readonly leased: boolean }[]>`
      select exists (select 1 from outbox_jobs where state = 'leased') as leased`
    if (rows[0]?.leased === true) {
      leaseObserved = true
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(leaseObserved, true)
  child.kill("SIGKILL")
  await new Promise<void>((resolve) => child.once("exit", () => resolve()))
  await blocker`select pg_advisory_unlock(987654321)`
  await blocker.end()
  await database.sql`drop trigger test_wait_inbox on delivery_inbox`
  await database.sql`drop function test_wait_inbox()`
  await database.sql`update outbox_jobs set lease_expires_at = clock_timestamp() - interval '1 second'`
  const restarted = spawn(process.execPath, ["--input-type=module", "--eval", workerScript], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: baseUrl, TEST_SCHEMA: schema },
    stdio: "ignore",
  })
  const exitCode = await new Promise<number | null>((resolve) => restarted.once("exit", resolve))

  // Then
  assert.equal(exitCode, 0)
  const rows = await database.sql<{ readonly count: number }[]>`
    select count(*)::integer as count from delivery_inbox`
  assert.equal(rows[0]?.count, 1)
})
