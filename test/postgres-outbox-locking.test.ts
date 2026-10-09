import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { after, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { IdentityNotActiveError } from "../src/identity/admin-errors.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { OutboxRepository } from "../src/outbox/repository.ts"
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
    workspaceId: "locking-workspace",
    workspaceName: "Locking Workspace",
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

async function createItem(store: AuthorizedPostgresWorkItemStore) {
  return store.create({
    workspaceId: workspaceId("locking-workspace"),
    title: workItemTitle("Locked item"),
    accountableOwnerId: humanPrincipalId("human-one"),
    actorId: actorId("human-one"),
    idempotencyKey: idempotencyKey(randomUUID()),
  })
}

const scope = { workspaceId: "locking-workspace", destinationId: "database-a" } as const

test("registration rejects missing and archived workspaces", async () => {
  const repository = new OutboxRepository(database.sql)
  await assert.rejects(
    repository.register({ workspaceId: "missing", destinationId: "database-a" }),
    IdentityNotActiveError,
  )
  const fixture = await setup()
  await database.sql`update workspaces set status = 'archived' where id = ${scope.workspaceId}`
  await assert.rejects(fixture.repository.register(scope), IdentityNotActiveError)
})

test("registration follows workspace-before-advisory lock order and preserves the cutoff", async () => {
  const fixture = await setup()
  const blocker = database.connect()
  let locked: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    locked = resolve
  })
  let continueTransaction: (() => void) | undefined
  const proceed = new Promise<void>((resolve) => {
    continueTransaction = resolve
  })
  const transaction = blocker.begin(async (sql) => {
    await sql`select id from workspaces where id = ${scope.workspaceId} for update`
    locked?.()
    await proceed
    await sql`select pg_advisory_xact_lock(hashtextextended(${scope.workspaceId}, 73491))`
  })
  await ready

  const registration = fixture.repository.register(scope)
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  continueTransaction?.()
  await transaction
  const cutoff = await registration
  await blocker.end()
  await createItem(fixture.store)

  assert.equal(cutoff, 0)
  const jobs = await database.sql<{ readonly count: number }[]>`
    select count(*)::integer as count from outbox_jobs`
  assert.equal(jobs[0]?.count, 1)
})

test("a locked expired maximum-attempt head returns without blocking or leapfrogging", async () => {
  const fixture = await setup()
  await fixture.repository.register(scope)
  await createItem(fixture.store)
  await createItem(fixture.store)
  const first = await fixture.repository.claim(scope)
  if (first === undefined) throw new Error("missing first claim")
  await database.sql`update outbox_jobs set attempts = 5,
    lease_expires_at = clock_timestamp() - interval '1 second' where job_id = ${first.jobId}`

  const blocker = database.connect()
  let unlock: (() => void) | undefined
  const release = new Promise<void>((resolve) => {
    unlock = resolve
  })
  let locked: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    locked = resolve
  })
  const transaction = blocker.begin(async (sql) => {
    await sql`select job_id from outbox_jobs where job_id = ${first.jobId} for update`
    locked?.()
    await release
  })
  await ready

  const result = await Promise.race([
    fixture.repository.claim(scope),
    new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
  ])
  unlock?.()
  await transaction
  await blocker.end()

  assert.equal(result, undefined)
  const states = await database.sql<{ readonly sequence: number; readonly state: string }[]>`
    select sequence::integer as sequence, state from outbox_jobs order by sequence`
  assert.deepEqual(
    states.map((row) => ({ ...row })),
    [
      { sequence: 1, state: "leased" },
      { sequence: 2, state: "pending" },
    ],
  )
})

test("CLI prints an unsuccessful summary and exits one after persisting a sink retry", async () => {
  const fixture = await setup()
  await fixture.repository.register(scope)
  await createItem(fixture.store)
  await database.sql`create function reject_test_inbox() returns trigger language plpgsql as $$
    begin raise exception 'test sink failure'; end $$`
  await database.sql`create trigger reject_test_inbox before insert on delivery_inbox
    for each row execute function reject_test_inbox()`
  const schemas = await database.sql<{ readonly schema: string }[]>`
    select current_schema() as schema`
  const schema = schemas[0]?.schema
  const { DATABASE_URL: baseUrl } = process.env
  if (schema === undefined || baseUrl === undefined) throw new Error("missing subprocess database")
  const scopedUrl = new URL(baseUrl)
  scopedUrl.searchParams.set("options", `-csearch_path=${schema}`)

  const child = spawn(
    process.execPath,
    [
      "app/outbox.mjs",
      "run",
      "--workspace-id",
      scope.workspaceId,
      "--destination-id",
      scope.destinationId,
      "--sink",
      "database-inbox",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: scopedUrl.toString() },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve))

  assert.equal(exitCode, 1)
  assert.equal(stdout, '{"claimed":1,"delivered":0,"failed":1}\n')
  assert.equal(stderr, "")
  const jobs = await database.sql<{ readonly state: string; readonly last_error: string }[]>`
    select state, last_error from outbox_jobs`
  assert.equal(jobs[0]?.state, "pending")
  assert.match(jobs[0]?.last_error ?? "", /test sink failure/)
})
