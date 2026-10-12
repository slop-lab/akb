import assert from "node:assert/strict"
import { test } from "node:test"
import type { Sql } from "postgres"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { resultId } from "./r4-command-http-fixture.ts"
import { createInterchangeHttpFixture } from "./r4-interchange-http-fixture.ts"
import { workflowCommand } from "./r4-workflow-http-helpers.ts"

test("creating and updating defaults canonically hand over the former state", async () => {
  const fixture = await createInterchangeHttpFixture()
  try {
    await new SpaceAdmin(fixture.sql).create({
      workspaceId: "w",
      spaceId: "delivery",
      spaceName: "Delivery",
      visibility: "public",
    })
    const [initial] = await fixture.sql<{ readonly id: string }[]>`
      select id from workflow_states where space_id='delivery' and active and is_default`
    if (initial === undefined) throw new TypeError("initial default missing")

    const created = await workflowCommand(fixture.request, {
      path: "/spaces/delivery/workflow/states",
      method: "POST",
      baseRevision: null,
      payload: statePayload("Created default", true, 5),
      key: "create-default",
    })
    assert.equal(created.status, 201, await created.clone().text())
    const createdId = resultId(await created.json())
    await assertHandover(fixture.sql, {
      formerId: initial.id,
      currentId: createdId,
      revision: 2,
      events: 1,
      originalDefault: true,
    })

    const candidate = await workflowCommand(fixture.request, {
      path: "/spaces/delivery/workflow/states",
      method: "POST",
      baseRevision: null,
      payload: statePayload("Update candidate", false, 6),
      key: "create-candidate",
    })
    const candidateId = resultId(await candidate.json())
    const updated = await workflowCommand(fixture.request, {
      path: `/spaces/delivery/workflow/states/${candidateId}`,
      method: "PATCH",
      baseRevision: 1,
      payload: { isDefault: true },
      key: "update-default",
    })
    assert.equal(updated.status, 200, await updated.clone().text())
    await assertHandover(fixture.sql, {
      formerId: createdId,
      currentId: candidateId,
      revision: 2,
      events: 2,
      originalDefault: true,
    })

    const replay = await workflowCommand(fixture.request, {
      path: `/spaces/delivery/workflow/states/${candidateId}`,
      method: "PATCH",
      baseRevision: 1,
      payload: { isDefault: true },
      key: "update-default",
    })
    assert.equal(replay.status, 200)
    await assertHandover(fixture.sql, {
      formerId: createdId,
      currentId: candidateId,
      revision: 2,
      events: 2,
      originalDefault: true,
    })
  } finally {
    await fixture.close()
  }
})

test("default handover rolls back when the former state denies manage authority", async () => {
  const { fixture, initialId } = await setupWorkflow()
  try {
    await fixture.sql`update entity_acl_policies set mode='restricted' where entity_id=${initialId}`
    await fixture.sql`delete from entity_acl_allowances where entity_id=${initialId}`

    const response = await workflowCommand(fixture.request, {
      path: "/spaces/delivery/workflow/states",
      method: "POST",
      baseRevision: null,
      payload: statePayload("Denied default", true, 5),
      key: "denied-default",
    })

    assert.equal(response.status, 404)
    assert.deepEqual(await workflowStateCounts(fixture.sql), {
      active: 5,
      defaults: 1,
      revisions: 5,
      events: 0,
    })
  } finally {
    await fixture.close()
  }
})

test("parent outbox failure rolls back the derived default handover", async () => {
  const { fixture, initialId } = await setupWorkflow()
  try {
    const candidate = await workflowCommand(fixture.request, {
      path: "/spaces/delivery/workflow/states",
      method: "POST",
      baseRevision: null,
      payload: statePayload("Candidate", false, 5),
      key: "outbox-candidate",
    })
    const candidateId = resultId(await candidate.json())
    const [sequence] = await fixture.sql<{ readonly value: number }[]>`
      select last_sequence::integer value from entity_event_sequences where workspace_id='w'`
    await fixture.sql`insert into entity_outbox_destinations_v1
      (workspace_id,destination_id,sink,start_after_sequence)
      values ('w','failure','database-inbox',${(sequence?.value ?? 0) + 1})`
    await fixture.sql`create function fail_parent_default_outbox() returns trigger language plpgsql as $$
      begin raise exception 'injected parent outbox failure'; end $$`
    await fixture.sql`create trigger fail_parent_default_outbox before insert on entity_outbox_jobs_v1
      for each row execute function fail_parent_default_outbox()`

    const response = await workflowCommand(fixture.request, {
      path: `/spaces/delivery/workflow/states/${candidateId}`,
      method: "PATCH",
      baseRevision: 1,
      payload: { isDefault: true },
      key: "outbox-default",
    })

    assert.equal(response.status, 500)
    const rows = await fixture.sql`
      select id,is_default,revision::integer revision from workflow_states
      where id in (${initialId},${candidateId}) order by id`
    assert.deepEqual(
      [...rows],
      [
        { id: candidateId, is_default: false, revision: 1 },
        { id: initialId, is_default: true, revision: 1 },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    )
  } finally {
    await fixture.close()
  }
})

test("the last public default cannot be unset directly", async () => {
  const { fixture, initialId } = await setupWorkflow()
  try {
    const response = await workflowCommand(fixture.request, {
      path: `/spaces/delivery/workflow/states/${initialId}`,
      method: "PATCH",
      baseRevision: 1,
      payload: { isDefault: false },
      key: "unset-last-default",
    })
    assert.equal(response.status, 409)
    const counts = await workflowStateCounts(fixture.sql)
    assert.equal(counts === undefined ? undefined : Reflect.get(counts, "defaults"), 1)
  } finally {
    await fixture.close()
  }
})

function statePayload(name: string, isDefault: boolean, position: number) {
  return { name, category: "unstarted", color: "#0284C7", position, isDefault }
}

type Fixture = Awaited<ReturnType<typeof createInterchangeHttpFixture>>

async function setupWorkflow(): Promise<{ readonly fixture: Fixture; readonly initialId: string }> {
  const fixture = await createInterchangeHttpFixture()
  await new SpaceAdmin(fixture.sql).create({
    workspaceId: "w",
    spaceId: "delivery",
    spaceName: "Delivery",
    visibility: "public",
  })
  const [initial] = await fixture.sql<{ readonly id: string }[]>`
    select id from workflow_states where space_id='delivery' and active and is_default`
  if (initial === undefined) throw new TypeError("initial default missing")
  return { fixture, initialId: initial.id }
}

async function workflowStateCounts(sql: Sql) {
  const [counts] = await sql`select count(*) filter (where active)::integer active,
    count(*) filter (where active and is_default)::integer defaults,
    (select count(*)::integer from entity_revisions where entity_id in
      (select id from workflow_states where space_id='delivery')) revisions,
    (select count(*)::integer from entity_events_v1 where subject_kind='workflow_state') events
    from workflow_states where space_id='delivery'`
  return counts
}

async function assertHandover(
  sql: Sql,
  input: {
    readonly formerId: string
    readonly currentId: string
    readonly revision: number
    readonly events: number
    readonly originalDefault: boolean | null
  },
): Promise<void> {
  const [state] = await sql<
    {
      readonly defaults: number
      readonly former_revision: number
      readonly current_default: boolean
      readonly former_events: number
      readonly original_default: boolean
      readonly historical_default: boolean
    }[]
  >`select count(*) filter (where active and is_default)::integer defaults,
      max(revision) filter (where id=${input.formerId})::integer former_revision,
      bool_or(is_default) filter (where id=${input.currentId}) current_default,
      (select count(*)::integer from entity_events_v1 where subject_id=${input.formerId}) former_events,
      (select coalesce(canonical_snapshot->>'is_default',canonical_snapshot->>'isDefault')::boolean from entity_revisions
        where entity_id=${input.formerId} order by revision limit 1) original_default,
      (select coalesce(canonical_snapshot->>'is_default',canonical_snapshot->>'isDefault')::boolean from entity_revisions
        where entity_id=${input.formerId} order by revision desc limit 1) historical_default
    from workflow_states where space_id='delivery'`
  assert.deepEqual(state, {
    defaults: 1,
    former_revision: input.revision,
    current_default: true,
    former_events: input.events,
    original_default: input.originalDefault,
    historical_default: false,
  })
}
