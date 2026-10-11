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

test("workflow rejects a twenty-first active state without partial persistence", async () => {
  await createSpace("engineering", "ENG")
  for (let index = 0; index < 15; index += 1) {
    const response = await api.send(
      "/spaces/engineering/workflow/states",
      "POST",
      null,
      {
        name: `Custom ${index}`,
        category: "started",
        color: "#2563EB",
        position: index + 5,
        isDefault: false,
      },
      `state-${index}`,
    )
    assert.equal(response.status, 201, JSON.stringify(response.body))
  }
  const before = await stateCounts()

  const rejected = await api.send(
    "/spaces/engineering/workflow/states",
    "POST",
    null,
    {
      name: "Twenty first",
      category: "started",
      color: "#2563EB",
      position: 19,
      isDefault: false,
    },
    "state-overflow",
  )

  assert.equal(rejected.status, 409, JSON.stringify(rejected.body))
  assert.deepEqual(await stateCounts(), before)
  assert.deepEqual(before, { entities: 20, events: 15, revisions: 20, states: 20 })
})

test("Work creation rejects state label and project references from another Space", async () => {
  await createSpace("engineering", "ENG")
  await createSpace("operations", "OPS")
  const states = await fixture.sql<{ readonly id: string; readonly space_id: string }[]>`
    select id,space_id from workflow_states where workspace_id='w' and category='unstarted'`
  const engineeringState = required(states.find((row) => row.space_id === "engineering")?.id)
  const operationsState = required(states.find((row) => row.space_id === "operations")?.id)
  const labelResponse = await api.send(
    "/spaces/operations/labels",
    "POST",
    null,
    { name: "Operations", color: "blue" },
    "operations-label",
  )
  const labelId = resultId(labelResponse.body)
  const projectResponse = await api.send(
    "/projects",
    "POST",
    null,
    {
      name: "Operations",
      slug: "operations",
      summary: "",
      ownerId: "owner",
      leadIds: ["owner"],
      participatingSpaceIds: ["operations"],
      state: "active",
      health: "on_track",
      priority: "none",
      startDate: null,
      targetDate: null,
    },
    "operations-project",
  )
  const projectId = resultId(projectResponse.body)

  const statuses = await Promise.all([
    createWork("cross-state", operationsState, null, []),
    createWork("cross-label", engineeringState, null, [labelId]),
    createWork("cross-project", engineeringState, projectId, []),
  ])

  assert.deepEqual(
    statuses.map((response) => response.status),
    [404, 409, 409],
  )
  const rows = await fixture.sql`select count(*)::integer count from work_items`
  assert.deepEqual([...rows], [{ count: 0 }])
})

async function createSpace(id: string, key: string): Promise<void> {
  const response = await api.send(
    "/spaces",
    "POST",
    null,
    { id, key, name: id, visibility: "public", description: "", icon: null, leadId: null },
    `space-${id}`,
  )
  assert.equal(response.status, 201, JSON.stringify(response.body))
}

function createWork(
  key: string,
  workflowStateId: string,
  projectId: string | null,
  labelIds: readonly string[],
) {
  return api.send(
    "/work-items",
    "POST",
    null,
    {
      spaceId: "engineering",
      title: key,
      accountableOwnerId: "owner",
      description: "",
      type: "Task",
      workflowStateId,
      projectId,
      priority: "none",
      labelIds,
      startDate: null,
      dueDate: null,
    },
    key,
  )
}

async function stateCounts(): Promise<Readonly<Record<string, number>>> {
  const rows = await fixture.sql`select
    (select count(*)::integer from workflow_states where space_id='engineering') states,
    (select count(*)::integer from entities where kind='workflow_state' and scope_space_id='engineering') entities,
    (select count(*)::integer from entity_revisions r join entities e on e.id=r.entity_id
      where e.kind='workflow_state' and e.scope_space_id='engineering') revisions,
    (select count(*)::integer from entity_events_v1 e join entities n on n.id=e.subject_id
      where n.kind='workflow_state' and n.scope_space_id='engineering') events`
  return required(rows[0])
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("required fixture value is missing")
  return value
}
