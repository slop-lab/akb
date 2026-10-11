import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { EntityOutboxRepository } from "../src/outbox/entity-repository.ts"
import { runDatabaseInboxWorker } from "../src/outbox/worker.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
after(database.close)
beforeEach(database.reset)

async function seedWorkspace(): Promise<void> {
  await new IdentityAdmin(database.sql).bootstrapWorkspace({
    workspaceId: "ops",
    workspaceName: "Operations",
    principalId: "operator",
    principalName: "Operator",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
}

async function appendEvent(id: string, sequence: number): Promise<void> {
  const entityId = `project:${id}`
  await database.sql`insert into entities
    (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    values (${entityId},'ops','project',1,'operator',clock_timestamp(),clock_timestamp())`
  await database.sql`insert into entity_acl_policies values (${entityId},'inherit')`
  await database.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    values (${entityId},1,'project.r4.v1',${database.sql.json({ id: entityId })},'operator',
      clock_timestamp(),repeat('0',64))`
  await database.sql`insert into entity_events_v1
    (id,workspace_id,sequence,event_type,subject_kind,subject_id,subject_revision,
      occurred_at,actor_id,data)
    values (${id},'ops',${sequence},'entity.created','project',${entityId},1,
      clock_timestamp(),'operator',${database.sql.json({ id: entityId })})`
}

test("entity-v1 worker redelivers a crashed claim without duplicating the inbox", async () => {
  // Given
  await seedWorkspace()
  const repository = new EntityOutboxRepository(database.sql)
  await repository.register({ workspaceId: "ops", destinationId: "sink" })
  await appendEvent("event-1", 1)
  const crashed = await repository.claim({ workspaceId: "ops", destinationId: "sink" }, 30)
  assert.ok(crashed)
  await repository.deliverToInbox(crashed)
  await database.sql`update entity_outbox_jobs_v1 set lease_expires_at=clock_timestamp()-interval '1 second'
    where job_id=${crashed.jobId}`

  // When
  const summary = await runDatabaseInboxWorker(
    repository,
    { workspaceId: "ops", destinationId: "sink" },
    { drain: true },
  )

  // Then
  const rows = await database.sql`select event_id from delivery_inbox_v1`
  assert.deepEqual(summary, { claimed: 1, delivered: 1, failed: 0 })
  assert.deepEqual(
    rows.map((row) => row["event_id"]),
    ["event-1"],
  )
})

test("entity-v1 worker dead-letters an exhausted head without leapfrogging", async () => {
  // Given
  await seedWorkspace()
  const repository = new EntityOutboxRepository(database.sql)
  await repository.register({ workspaceId: "ops", destinationId: "sink" })
  await appendEvent("event-1", 1)
  await appendEvent("event-2", 2)
  await database.sql`update entity_outbox_jobs_v1 set state='leased',attempts=5,
    lease_owner=gen_random_uuid(),lease_expires_at=clock_timestamp()-interval '1 second'
    where event_id='event-1'`

  // When
  const blocked = await repository.claim({ workspaceId: "ops", destinationId: "sink" })

  // Then
  const jobs =
    await database.sql`select job_id,event_id,state from entity_outbox_jobs_v1 order by sequence`
  assert.equal(blocked, undefined)
  assert.deepEqual(
    jobs.map(({ event_id, state }) => [event_id, state]),
    [
      ["event-1", "dead_letter"],
      ["event-2", "pending"],
    ],
  )
  assert.equal(
    await repository.retryDead(
      { workspaceId: "ops", destinationId: "sink" },
      String(jobs[0]?.["job_id"]),
    ),
    true,
  )
  assert.equal((await repository.claim({ workspaceId: "ops", destinationId: "sink" }))?.sequence, 1)
})

test("entity-v1 acknowledgement is fenced by lease generation and expiry", async () => {
  // Given
  await seedWorkspace()
  const repository = new EntityOutboxRepository(database.sql)
  await repository.register({ workspaceId: "ops", destinationId: "sink" })
  await appendEvent("event-1", 1)
  const delivery = await repository.claim({ workspaceId: "ops", destinationId: "sink" })
  assert.ok(delivery)
  await database.sql`update entity_outbox_jobs_v1 set lease_generation=lease_generation+1
    where job_id=${delivery.jobId}`

  // When
  const acknowledged = await repository.acknowledge(delivery)

  // Then
  assert.equal(acknowledged, false)
})
