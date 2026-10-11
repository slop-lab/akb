import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, test } from "node:test"
import { createR4CommandRouter } from "../src/http/command-v1/router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
})

afterEach(async () => {
  await fixture.close()
})

test("authenticated commands create Space Project and Work atomically and replay safely", async () => {
  // Given
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  let legacyId = 0
  const server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId(`legacy-${++legacyId}`),
      newEventId: () => eventId(`legacy-event-${legacyId}`),
      now: () => "2026-01-02T03:04:05.000Z",
    },
    [createR4CommandRouter(fixture.sql)],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo
  const base = `http://127.0.0.1:${address.port}/api/commands/v1/workspaces/w`
  const send = async (
    path: string,
    method: string,
    baseRevision: number | null,
    payload: unknown,
    key: string,
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `command-${key}`,
        idempotencyKey: key,
        baseRevision,
        payload,
      }),
    })
    return { status: response.status, body: await response.json() }
  }

  try {
    // When
    const space = await send(
      "/spaces",
      "POST",
      null,
      {
        id: "engineering",
        key: "ENG",
        name: "Engineering",
        visibility: "private",
        description: "",
        icon: null,
        leadId: "owner",
      },
      "space-create",
    )
    const replay = await send(
      "/spaces",
      "POST",
      null,
      {
        id: "engineering",
        key: "ENG",
        name: "Engineering",
        visibility: "private",
        description: "",
        icon: null,
        leadId: "owner",
      },
      "space-create",
    )
    const states = await fixture.sql<{ readonly id: string }[]>`
      select id from workflow_states where workspace_id='w' and space_id='engineering'
        and category='unstarted'`
    const workflowStateId = states[0]?.id
    if (workflowStateId === undefined) throw new Error("missing default workflow state")
    const project = await send(
      "/projects",
      "POST",
      null,
      {
        name: "Launch",
        slug: "launch",
        summary: "",
        ownerId: "owner",
        leadIds: ["owner"],
        participatingSpaceIds: ["engineering"],
        state: "active",
        health: "on_track",
        priority: "high",
        startDate: null,
        targetDate: null,
      },
      "project-create",
    )
    const projectBody = resultBody(project.body)
    const projectId = stringField(projectBody.result, "id")
    const work = await send(
      "/work-items",
      "POST",
      null,
      {
        spaceId: "engineering",
        title: "Ship",
        accountableOwnerId: "owner",
        description: "",
        type: "Task",
        workflowStateId,
        projectId,
        priority: "urgent",
        labelIds: [],
        startDate: null,
        dueDate: null,
      },
      "work-create",
    )
    const workId = stringField(resultBody(work.body).result, "id")
    const update = await send(
      `/work-items/${workId}`,
      "PATCH",
      1,
      {
        title: "Ship safely",
      },
      "work-update",
    )
    const stale = await send(
      `/work-items/${workId}`,
      "PATCH",
      1,
      {
        title: "Overwrite stale state",
      },
      "work-stale",
    )
    const mismatchedReplay = await send(
      "/work-items",
      "POST",
      null,
      {
        spaceId: "engineering",
        title: "Different command",
        accountableOwnerId: "owner",
        description: "",
        type: "Task",
        workflowStateId,
        projectId,
        priority: "urgent",
        labelIds: [],
        startDate: null,
        dueDate: null,
      },
      "work-create",
    )
    const actorInjection = await send(
      "/spaces/engineering/labels",
      "POST",
      null,
      {
        name: "Backend",
        color: "blue",
        actorId: "attacker",
      },
      "actor-injection",
    )

    // Then
    assert.equal(space.status, 201)
    assert.equal(replay.status, 200, JSON.stringify(replay.body))
    assert.equal(resultBody(replay.body).replayed, true)
    assert.equal(project.status, 201)
    assert.equal(work.status, 201)
    assert.equal(update.status, 200)
    assert.equal(stale.status, 409)
    assert.equal(mismatchedReplay.status, 409)
    assert.equal(actorInjection.status, 400)
    const counts = await fixture.sql`select
      (select count(*)::integer from work_item_pm where work_item_id=${workId}) pm,
      (select count(*)::integer from domain_events where subject_id=${workId}) legacy_events,
      (select count(*)::integer from entity_events_v1 where subject_id=${workId}) generic_events,
      (select count(*)::integer from entity_revisions where entity_id=${workId}) revisions,
      (select title from work_items where id=${workId}) title,
      (select count(*)::integer from labels where workspace_id='w') labels`
    assert.deepEqual(
      [...counts],
      [
        {
          pm: 1,
          legacy_events: 2,
          generic_events: 2,
          revisions: 2,
          title: "Ship safely",
          labels: 0,
        },
      ],
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

function resultBody(value: unknown): {
  readonly result: Readonly<Record<string, unknown>>
  readonly replayed: boolean
} {
  if (
    typeof value !== "object" ||
    value === null ||
    !("result" in value) ||
    !("replayed" in value)
  ) {
    throw new TypeError("response is not a command result")
  }
  const result = value.result
  if (!isRecord(result)) throw new TypeError("command result is invalid")
  return { result, replayed: value.replayed === true }
}

function stringField(value: Readonly<Record<string, unknown>>, field: string): string {
  const result = value[field]
  if (typeof result !== "string") throw new TypeError(`missing ${field}`)
  return result
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
