import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"
import { type R4CommandApi, resultId, startR4CommandApi } from "./r4-command-http-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let api: R4CommandApi

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  api = await startR4CommandApi(fixture)
})

afterEach(async () => {
  await api.close()
  await fixture.close()
})

test("generic outbox failure rolls back current generic and legacy Work streams", async () => {
  await api.send(
    "/spaces",
    "POST",
    null,
    {
      id: "engineering",
      key: "ENG",
      name: "Engineering",
      visibility: "public",
      description: "",
      icon: null,
      leadId: null,
    },
    "space",
  )
  const states = await fixture.sql<{ readonly id: string }[]>`
    select id from workflow_states where space_id='engineering' and category='unstarted'`
  const stateId = required(states[0]?.id)
  const created = await api.send(
    "/work-items",
    "POST",
    null,
    {
      spaceId: "engineering",
      title: "Original",
      accountableOwnerId: "owner",
      description: "Original description",
      type: "Task",
      workflowStateId: stateId,
      projectId: null,
      priority: "high",
      labelIds: [],
      startDate: "2026-01-01",
      dueDate: "2026-01-31",
    },
    "work",
  )
  const workId = resultId(created.body)
  const sequence = await fixture.sql<{ readonly sequence: number }[]>`
    select last_sequence::integer sequence from entity_event_sequences where workspace_id='w'`
  await fixture.sql`insert into entity_outbox_destinations_v1
    (workspace_id,destination_id,sink,start_after_sequence) values
    ('w','failure','database-inbox',${required(sequence[0]?.sequence)})`
  const before = await workState(workId)
  await fixture.sql`create function fail_r4_outbox_job() returns trigger language plpgsql as $$
    begin raise exception 'injected generic outbox failure'; end $$`
  await fixture.sql`create trigger fail_r4_outbox_job before insert on entity_outbox_jobs_v1
    for each row execute function fail_r4_outbox_job()`

  const response = await api.send(
    `/work-items/${workId}`,
    "PATCH",
    1,
    { title: "Must roll back", description: "Must roll back" },
    "failed-update",
  )

  assert.equal(response.status, 500, JSON.stringify(response.body))
  assert.deepEqual(await workState(workId), before)
})

test("legacy title PATCH preserves custom workflow state and PM metadata", async () => {
  await api.send(
    "/spaces",
    "POST",
    null,
    {
      id: "engineering",
      key: "ENG",
      name: "Engineering",
      visibility: "public",
      description: "",
      icon: null,
      leadId: null,
    },
    "space",
  )
  const state = await api.send(
    "/spaces/engineering/workflow/states",
    "POST",
    null,
    { name: "Review", category: "started", color: "#2563EB", position: 10, isDefault: false },
    "review-state",
  )
  const stateId = resultId(state.body)
  const created = await api.send(
    "/work-items",
    "POST",
    null,
    {
      spaceId: "engineering",
      title: "Original",
      accountableOwnerId: "owner",
      description: "Keep description",
      type: "Milestone",
      workflowStateId: stateId,
      projectId: null,
      priority: "urgent",
      labelIds: [],
      startDate: "2026-01-01",
      dueDate: "2026-01-31",
    },
    "work",
  )
  const workId = resultId(created.body)

  const access = await api.send(
    `/entities/${workId}/access`,
    "PUT",
    1,
    {
      mode: "restricted",
      allowances: [
        { principalId: "owner", permissions: ["work.read", "work.update", "acl.manage"] },
      ],
    },
    "work-access-before-legacy",
  )
  const response = await api.patchLegacyWork(workId, 2, "Legacy title")

  assert.equal(access.status, 200, JSON.stringify(access.body))
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const rows = await fixture.sql`select w.title,w.state,pm.description,pm.item_type,
    pm.workflow_state_id,pm.priority,pm.start_date::text,pm.due_date::text,w.revision::integer,
    (select schema_version from entity_revisions where entity_id=w.id and revision=2) access_schema,
    (select canonical_snapshot->>'title' from entity_revisions where entity_id=w.id and revision=2) access_title,
    (select count(*)::integer from work_item_revisions where work_item_id=w.id) legacy_revisions,
    (select count(*)::integer from domain_events where subject_id=w.id) legacy_events
    from work_items w join work_item_pm pm on pm.work_item_id=w.id where w.id=${workId}`
  assert.deepEqual(
    [...rows],
    [
      {
        title: "Legacy title",
        state: "started",
        description: "Keep description",
        item_type: "Milestone",
        workflow_state_id: stateId,
        priority: "urgent",
        start_date: "2026-01-01",
        due_date: "2026-01-31",
        revision: 3,
        access_schema: "work-item.r4.v1",
        access_title: "Original",
        legacy_revisions: 3,
        legacy_events: 3,
      },
    ],
  )
})

async function workState(workId: string): Promise<Readonly<Record<string, unknown>>> {
  const rows = await fixture.sql`select
    (select title from work_items where id=${workId}) title,
    (select description from work_item_pm where work_item_id=${workId}) description,
    (select current_revision::integer from entities where id=${workId}) revision,
    (select count(*)::integer from entity_revisions where entity_id=${workId}) revisions,
    (select count(*)::integer from entity_events_v1 where subject_id=${workId}) events,
    (select count(*)::integer from entity_outbox_events_v1 o join entity_events_v1 e on e.id=o.event_id
      where e.subject_id=${workId}) outbox_events,
    (select count(*)::integer from entity_outbox_jobs_v1 j join entity_events_v1 e on e.id=j.event_id
      where e.subject_id=${workId}) outbox_jobs,
    (select count(*)::integer from work_item_revisions where work_item_id=${workId}) legacy_revisions,
    (select count(*)::integer from domain_events where subject_id=${workId}) legacy_events,
    (select count(*)::integer from generic_command_idempotency where subject_id=${workId}) commands`
  return required(rows[0])
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("required fixture value is missing")
  return value
}
