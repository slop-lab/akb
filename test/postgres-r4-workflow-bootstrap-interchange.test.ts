import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { createInterchangeHttpFixture, validateAndCommit } from "./r4-interchange-http-fixture.ts"

test("edited bootstrap workflow configuration round-trips into a retargeted Space", async () => {
  // Given
  const source = await createInterchangeHttpFixture()
  const destination = await createInterchangeHttpFixture()
  try {
    await new SpaceAdmin(source.sql).create({
      workspaceId: "w",
      spaceId: "delivery",
      spaceName: "Delivery",
      visibility: "public",
    })
    const replacement = await command(
      source.request,
      "/spaces/delivery/workflow/states",
      "POST",
      null,
      {
        name: "Rejected",
        category: "canceled",
        color: "#991B1B",
        position: 5,
        isDefault: false,
      },
      "replacement",
    )
    assert.equal(replacement.status, 201)
    const states = await source.sql<
      { readonly category: string; readonly id: string; readonly revision: number }[]
    >`select id,category,revision::integer revision from workflow_states where space_id='delivery'`
    const byCategory = new Map(states.map((state) => [state.category, state]))
    const backlog = requiredState(byCategory, "backlog")
    const started = requiredState(byCategory, "started")
    const completed = requiredState(byCategory, "completed")
    const unstarted = requiredState(byCategory, "unstarted")
    const canceled = requiredState(byCategory, "canceled")
    await patchState(source.request, backlog.id, backlog.revision, { position: 10 }, "backlog-temp")
    await patchState(source.request, started.id, started.revision, { position: 0 }, "started-move")
    await patchState(
      source.request,
      backlog.id,
      backlog.revision + 1,
      { name: "Ideas", color: "#123456", position: 2 },
      "backlog-edit",
    )
    await patchState(
      source.request,
      completed.id,
      completed.revision,
      { isDefault: true },
      "default-new",
    )
    await patchState(
      source.request,
      unstarted.id,
      unstarted.revision,
      { isDefault: false },
      "default-old",
    )
    const archived = await command(
      source.request,
      `/spaces/delivery/workflow/states/${canceled.id}/archive`,
      "POST",
      canceled.revision,
      {},
      "archive-canceled",
    )
    assert.equal(archived.status, 200)
    const work = await command(
      source.request,
      "/work-items",
      "POST",
      null,
      {
        spaceId: "delivery",
        title: "Mapped work",
        accountableOwnerId: "owner",
        description: "",
        type: "Task",
        workflowStateId: started.id,
        projectId: null,
        priority: "none",
        labelIds: [],
        startDate: null,
        dueDate: null,
      },
      "mapped-work",
    )
    assert.equal(work.status, 201, await work.clone().text())
    const exported = await source.request("/api/human/v1/workspaces/w/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeArchived: true, spaceId: "delivery" }),
    })
    const sourceBytes = await exported.text()
    assert.equal(exported.status, 200, sourceBytes)
    const bytes = retargetSpace(sourceBytes, "delivery", "restored-delivery")

    // When
    const result = await validateAndCommit(
      destination.request,
      bytes,
      "11111111-1111-4111-8111-111111111111",
    )

    // Then
    assert.equal(result.validated.status, 200)
    assert.equal(result.commit?.status, 200, await result.commit?.clone().text())
    const restored = await destination.request("/api/human/v1/workspaces/w/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeArchived: true, spaceId: "restored-delivery" }),
    })
    assert.equal(restored.status, 200)
    assert.deepEqual(workflowAttributes(await restored.text()), workflowAttributes(bytes))
    const [mappedWork] = await destination.sql<
      { readonly category: string; readonly space_id: string; readonly state_name: string }[]
    >`select ws.category,w.space_id,ws.name state_name from work_items w
      join work_item_pm pm on pm.work_item_id=w.id
      join workflow_states ws on ws.id=pm.workflow_state_id
      where w.title='Mapped work'`
    assert.deepEqual(mappedWork, {
      category: "started",
      space_id: "restored-delivery",
      state_name: "Started",
    })
    const [evidence] = await destination.sql<
      { readonly actors: number; readonly events: number }[]
    >`select count(*)::integer events,count(*) filter (where actor_id='owner')::integer actors
      from entity_events_v1 where subject_kind='workflow_state'`
    assert.deepEqual(evidence, { actors: 12, events: 12 })
  } finally {
    await source.close()
    await destination.close()
  }
})

function requiredState(
  states: ReadonlyMap<string, { readonly id: string; readonly revision: number }>,
  category: string,
) {
  const state = states.get(category)
  if (state === undefined) throw new TypeError(`${category} state missing`)
  return state
}

async function patchState(
  request: (path: string, init: RequestInit) => Promise<Response>,
  id: string,
  revision: number,
  payload: unknown,
  key: string,
): Promise<void> {
  const response = await command(
    request,
    `/spaces/delivery/workflow/states/${id}`,
    "PATCH",
    revision,
    payload,
    key,
  )
  assert.equal(response.status, 200, await response.clone().text())
}

function command(
  request: (path: string, init: RequestInit) => Promise<Response>,
  path: string,
  method: "POST" | "PATCH",
  baseRevision: number | null,
  payload: unknown,
  key: string,
) {
  return request(`/api/commands/v1/workspaces/w${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: key, idempotencyKey: key, baseRevision, payload }),
  })
}

function workflowRecords(bytes: string) {
  return bytes
    .trimEnd()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
    .filter((record) => Reflect.get(record, "kind") === "workflow_state")
    .sort((left, right) =>
      z
        .string()
        .parse(Reflect.get(left, "externalId"))
        .localeCompare(z.string().parse(Reflect.get(right, "externalId"))),
    )
}

function workflowAttributes(bytes: string) {
  return workflowRecords(bytes)
    .map(({ externalId: _, spaceId: __, ...record }) => record)
    .sort((left, right) =>
      z
        .string()
        .parse(Reflect.get(left, "name"))
        .localeCompare(z.string().parse(Reflect.get(right, "name"))),
    )
}

function retargetSpace(bytes: string, sourceId: string, destinationId: string): string {
  const records = bytes
    .trimEnd()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
    .map((record) => {
      if (Reflect.get(record, "kind") === "space" && Reflect.get(record, "externalId") === sourceId)
        return { ...record, externalId: destinationId, key: "RST" }
      return Reflect.get(record, "spaceId") === sourceId
        ? { ...record, spaceId: destinationId }
        : record
    })
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}
