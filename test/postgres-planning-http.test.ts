import assert from "node:assert/strict"
import type { Server } from "node:http"
import { after, beforeEach, test } from "node:test"
import { z } from "zod"
import { createR4CommandRouter } from "../src/http/command-v1/router.ts"
import { createR4HumanRouter } from "../src/http/human-v1/human-router.ts"
import { createPlanningRoutes } from "../src/http/planning/index.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createUnmigratedPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createUnmigratedPostgresTestFixture()
await migrateDatabase(database.sql)
after(database.close)
beforeEach(async () => {
  await database.sql`truncate delivery_inbox,delivery_inbox_v1,workspaces,work_items,
    workspace_event_sequences cascade`
})

test("authenticated planning API runs lifecycle, conflicts, rollover, progress, templates and notifications", async () => {
  // Given
  const fixture = await startPlanningApi()
  try {
    const project = await fixture.r4("/projects", "POST", null, projectPayload(), "project")
    const projectId = resultId(project.body)
    const stateRows = await database.sql<{ readonly id: string }[]>`
      select id from workflow_states where space_id='delivery' and category='unstarted'`
    const stateId = required(stateRows[0]?.id)
    const work = await fixture.r4(
      "/work-items",
      "POST",
      null,
      workPayload(projectId, stateId),
      "work",
    )
    const workId = resultId(work.body)
    const current = await fixture.planning(
      "/spaces/delivery/cycles",
      "POST",
      null,
      cyclePayload("Current", "2026-10-01", "2026-10-14"),
      "cycle-current",
    )
    assert.equal(current.status, 201, JSON.stringify(current.body))
    const currentId = resultId(current.body)
    const activated = await fixture.planning(
      `/cycles/${currentId}/activate`,
      "POST",
      1,
      {},
      "cycle-activate",
    )
    assert.equal(activated.status, 200)
    const next = await fixture.planning(
      "/spaces/delivery/cycles",
      "POST",
      null,
      cyclePayload("Next", "2026-10-15", "2026-10-28"),
      "cycle-next",
    )
    const nextId = resultId(next.body)
    const milestone = await fixture.planning(
      `/projects/${projectId}/milestones`,
      "POST",
      null,
      { name: "Beta", description: "", targetDate: "2026-10-20", position: 0 },
      "milestone",
    )
    const milestoneId = resultId(milestone.body)
    const module = await fixture.planning(
      `/projects/${projectId}/modules`,
      "POST",
      null,
      {
        name: "Core",
        description: "",
        ownerId: "owner",
        startDate: "2026-10-01",
        targetDate: "2026-10-20",
        status: "active",
      },
      "module",
    )
    const moduleId = resultId(module.body)

    // When
    const assigned = await fixture.planning(
      `/work-items/${workId}/planning`,
      "PUT",
      1,
      { estimate: 5, cycleId: currentId, milestoneId, moduleIds: [moduleId] },
      "assign",
    )
    const progress = await fixture.get(`/projects/${projectId}/progress`)
    const update = await fixture.planning(
      `/projects/${projectId}/updates`,
      "POST",
      null,
      { health: "on_track", body: "On schedule" },
      "update",
    )
    const template = await fixture.planning(
      "/templates",
      "POST",
      null,
      {
        name: "Project starter",
        kind: "project",
        content: {
          type: "project",
          fields: {},
          labels: [],
          relations: [],
          checklist: [],
          guidance: "",
        },
      },
      "template",
    )
    const templateId = resultId(template.body)
    const applied = await fixture.planning(
      `/templates/${templateId}/apply`,
      "POST",
      null,
      { templateRevision: 1, targetEntityId: projectId, targetKind: "project" },
      "template-apply",
    )
    const rollover = await fixture.planning(
      `/cycles/${currentId}/rollover`,
      "POST",
      2,
      { targetCycleId: nextId, targetCycleRevision: 1, workItems: [{ id: workId, revision: 2 }] },
      "rollover",
    )
    const conflict = await fixture.planning(
      `/cycles/${currentId}`,
      "PATCH",
      2,
      { goal: "stale" },
      "stale-cycle",
    )
    const replay = await fixture.planning(
      "/spaces/delivery/cycles",
      "POST",
      null,
      cyclePayload("Next", "2026-10-15", "2026-10-28"),
      "cycle-next",
    )

    // Then
    assert.equal(assigned.status, 200)
    assert.deepEqual(progress.body, {
      projectId,
      mode: "estimate",
      total: 5,
      completed: 0,
      blocked: 0,
      percent: 0,
    })
    const canceledRows = await database.sql<{ readonly id: string }[]>`
      select id from workflow_states where space_id='delivery' and category='canceled'`
    const canceledStateId = required(canceledRows[0]?.id)
    const child = await fixture.r4(
      "/work-items",
      "POST",
      null,
      workPayload(projectId, stateId, "Child"),
      "child-work",
    )
    const childId = resultId(child.body)
    const canceled = await fixture.r4(
      "/work-items",
      "POST",
      null,
      workPayload(projectId, canceledStateId, "Canceled"),
      "canceled-work",
    )
    const canceledId = resultId(canceled.body)
    assert.equal(
      (
        await fixture.planning(
          `/work-items/${childId}/planning`,
          "PUT",
          1,
          { estimate: null, cycleId: null, milestoneId: null, moduleIds: [] },
          "assign-child",
        )
      ).status,
      200,
    )
    assert.equal(
      (
        await fixture.planning(
          `/work-items/${canceledId}/planning`,
          "PUT",
          1,
          { estimate: 13, cycleId: null, milestoneId: null, moduleIds: [] },
          "assign-canceled",
        )
      ).status,
      200,
    )
    assert.equal(
      (
        await fixture.r4(
          "/relations",
          "POST",
          null,
          { fromEntityId: workId, relationType: "parent_of", toEntityId: childId },
          "parent-child",
        )
      ).status,
      201,
    )
    assert.deepEqual((await fixture.get(`/projects/${projectId}/progress`)).body, {
      projectId,
      mode: "count",
      total: 1,
      completed: 0,
      blocked: 0,
      percent: 0,
    })
    assert.equal(update.status, 201, JSON.stringify(update.body))
    assert.equal(applied.status, 201)
    assert.equal(rollover.status, 200)
    assert.equal(conflict.status, 409)
    assert.equal(z.object({ replayed: z.boolean() }).parse(replay.body).replayed, true)
    const inbox = await fixture.get("/inbox")
    assert.equal(
      z.object({ notifications: z.array(z.unknown()).min(1) }).parse(inbox.body).notifications
        .length,
      1,
    )
    const preferences = await fixture.planning(
      "/notification-preferences",
      "POST",
      null,
      { preferences: [{ eventType: "project_update", inApp: false }] },
      "preferences",
    )
    assert.equal(preferences.status, 201)
    assert.equal(
      (
        await fixture.planning(
          `/projects/${projectId}/updates`,
          "POST",
          null,
          { health: "on_track", body: "Still on schedule" },
          "update-muted",
        )
      ).status,
      201,
    )
    const mutedInbox = z
      .object({ notifications: z.array(z.unknown()) })
      .parse((await fixture.get("/inbox")).body)
    assert.equal(mutedInbox.notifications.length, 1)
    const timeline = await fixture.get(`/projects/${projectId}/timeline`)
    assert.ok(
      z.object({ entries: z.array(z.unknown()).min(4) }).parse(timeline.body).entries.length >= 4,
    )
    const planning = await database.sql<{ readonly cycle_id: string }[]>`
      select cycle_id from work_item_planning where work_item_id=${workId}`
    assert.equal(planning[0]?.cycle_id, nextId)
    const atomic = await database.sql<{ readonly count: number }[]>`
      select count(*)::integer count from generic_command_events
      where idempotency_key='rollover'`
    assert.equal(atomic[0]?.count, 3)
    const detail = await fixture.humanGet(`/work-items/${workId}`)
    assert.equal(detail.status, 200, JSON.stringify(detail.body))
    assert.equal(z.object({ id: z.string(), revision: z.number() }).parse(detail.body).revision, 3)
    const workQuery = {
      model: "r4",
      filter: { op: "eq", field: "projectId", value: projectId },
      search: null,
      sort: [{ field: "createdAt", direction: "asc" }],
      includeArchived: false,
      page: { size: 20, cursor: null },
    }
    const list = await fixture.humanPost("/work-items/query", workQuery)
    assert.equal(list.status, 200, JSON.stringify(list.body))
    assert.ok(
      z
        .object({ items: z.array(z.object({ id: z.string() })) })
        .parse(list.body)
        .items.some((item) => item.id === workId),
    )
    const board = await fixture.humanPost("/work-items/board", {
      ...workQuery,
      workflowStateId: null,
      page: { size: 20, cursor: null },
    })
    assert.equal(board.status, 200, JSON.stringify(board.body))
    assert.ok(
      z
        .object({
          columns: z.array(z.object({ cards: z.array(z.object({ id: z.string() })) })),
        })
        .parse(board.body)
        .columns.some((column) => column.cards.some((card) => card.id === workId)),
    )
    const history = await fixture.humanGet(`/entities/${workId}/history`)
    assert.equal(history.status, 200, JSON.stringify(history.body))
    assert.deepEqual(
      z
        .array(
          z.object({
            revision: z.number(),
            schemaVersion: z.string(),
            snapshot: z.record(z.string(), z.unknown()),
          }),
        )
        .parse(history.body)
        .slice(0, 3)
        .map((entry) => [entry.revision, entry.schemaVersion]),
      [
        [3, "work-item.r4.v1"],
        [2, "work-item.r4.v1"],
        [1, "work-item.r4.v1"],
      ],
    )
    const bridges = await database.sql<
      { readonly revisions: number[]; readonly events: number[] }[]
    >`
      select array_agg(revision order by revision)::integer[] revisions,
        (select array_agg(subject_revision order by subject_revision)::integer[] from domain_events
          where subject_id=${workId}) events
      from work_item_revisions where work_item_id=${workId}`
    assert.deepEqual(bridges[0], { revisions: [1, 2, 3], events: [1, 2, 3] })
    const admin = new IdentityAdmin(database.sql)
    await admin.provisionPrincipal({
      workspaceId: "w",
      principalId: "guest",
      displayName: "Guest",
      kind: "human",
      role: "guest",
      permissions: ["space.read", "work.read", "work.update", "project.read"],
    })
    const guest = await admin.issueToken({
      workspaceId: "w",
      principalId: "guest",
      expiresAt: "2030-01-01T00:00:00.000Z",
    })
    await database.sql`update entity_acl_policies set mode='restricted'
      where entity_id=any(${database.sql.array([nextId, milestoneId, moduleId])})`
    for (const assignment of [
      { estimate: null, cycleId: nextId, milestoneId: null, moduleIds: [] },
      { estimate: null, cycleId: null, milestoneId, moduleIds: [] },
      { estimate: null, cycleId: null, milestoneId: null, moduleIds: [moduleId] },
    ]) {
      const revisions = await database.sql<{ readonly current_revision: number }[]>`
        select current_revision::integer from entities where id=${childId}`
      const denied = await fixture.planningAs(
        guest.token,
        `/work-items/${childId}/planning`,
        revisions[0]?.current_revision ?? 0,
        assignment,
      )
      assert.equal(denied.status, 404, JSON.stringify(denied.body))
    }
    await new SpaceAdmin(database.sql).setVisibility({
      workspaceId: "w",
      spaceId: "delivery",
      visibility: "private",
    })
    assert.equal((await fixture.getAs(guest.token, "/spaces/delivery/cycles")).status, 404)
  } finally {
    await fixture.close()
  }
})

type ResponseBody = { readonly status: number; readonly body: unknown }

async function startPlanningApi() {
  const issued = await new IdentityAdmin(database.sql).bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await new SpaceAdmin(database.sql).create({
    workspaceId: "w",
    spaceId: "delivery",
    spaceName: "Delivery",
    visibility: "public",
  })
  let legacy = 0
  const server = createAuthenticatedPostgresServer(
    database.sql,
    {
      newWorkItemId: () => workItemId(`legacy-${++legacy}`),
      newEventId: () => eventId(`legacy-event-${legacy}`),
      now: () => "2026-10-17T12:00:00.000Z",
    },
    [
      ...createPlanningRoutes(database.sql),
      createR4CommandRouter(database.sql),
      createR4HumanRouter(database.sql, new Uint8Array(32).fill(7)),
    ],
  )
  await listen(server)
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new TypeError("server address unavailable")
  const origin = `http://127.0.0.1:${address.port}`
  const send = async (
    base: string,
    path: string,
    method: string,
    revision: number | null,
    payload: unknown,
    key: string,
  ): Promise<ResponseBody> => {
    const response = await fetch(`${origin}${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `command-${key}`,
        idempotencyKey: key,
        baseRevision: revision,
        payload,
      }),
    })
    return { status: response.status, body: await response.json() }
  }
  return {
    r4: (path: string, method: string, revision: number | null, payload: unknown, key: string) =>
      send("/api/commands/v1/workspaces/w", path, method, revision, payload, key),
    planning: (
      path: string,
      method: string,
      revision: number | null,
      payload: unknown,
      key: string,
    ) => send("/api/planning/v1/workspaces/w", path, method, revision, payload, key),
    get: async (path: string): Promise<ResponseBody> => {
      const response = await fetch(`${origin}/api/planning/v1/workspaces/w${path}`, {
        headers: { authorization: `Bearer ${issued.token}` },
      })
      return { status: response.status, body: await response.json() }
    },
    getAs: async (token: string, path: string): Promise<ResponseBody> => {
      const response = await fetch(`${origin}/api/planning/v1/workspaces/w${path}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      return { status: response.status, body: await response.json() }
    },
    humanGet: async (path: string): Promise<ResponseBody> => {
      const response = await fetch(`${origin}/api/human/v1/workspaces/w${path}`, {
        headers: { authorization: `Bearer ${issued.token}` },
      })
      return { status: response.status, body: await response.json() }
    },
    humanPost: async (path: string, payload: unknown): Promise<ResponseBody> => {
      const response = await fetch(`${origin}/api/human/v1/workspaces/w${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      return { status: response.status, body: await response.json() }
    },
    planningAs: async (
      token: string,
      path: string,
      revision: number,
      payload: unknown,
    ): Promise<ResponseBody> => {
      const key = `guest-${crypto.randomUUID()}`
      const response = await fetch(`${origin}/api/planning/v1/workspaces/w${path}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          commandId: `command-${key}`,
          idempotencyKey: key,
          baseRevision: revision,
          payload,
        }),
      })
      return { status: response.status, body: await response.json() }
    },
    close: () => close(server),
  }
}

function projectPayload() {
  return {
    name: "Launch",
    slug: "launch",
    summary: "",
    ownerId: "owner",
    leadIds: [],
    participatingSpaceIds: ["delivery"],
    state: "active",
    health: "on_track",
    priority: "high",
    startDate: "2026-10-01",
    targetDate: "2026-10-31",
  }
}
function workPayload(projectId: string, workflowStateId: string, title = "Ship") {
  return {
    spaceId: "delivery",
    title,
    accountableOwnerId: "owner",
    description: "",
    type: "Task",
    workflowStateId,
    projectId,
    priority: "high",
    labelIds: [],
    startDate: "2026-10-01",
    dueDate: "2026-10-20",
  }
}
function cyclePayload(name: string, startDate: string, endDate: string) {
  return { name, startDate, endDate, goal: "Ship", capacityHint: 10, rolloverPolicy: "reviewed" }
}
function resultId(value: unknown): string {
  return z.object({ result: z.object({ id: z.string() }) }).parse(value).result.id
}
function required(value: string | undefined): string {
  if (value === undefined) throw new TypeError("required value missing")
  return value
}
function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}
