import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { createInterchangeHttpFixture, validateAndCommit } from "./r4-interchange-http-fixture.ts"

const scenarios = [
  { includeArchived: false, title: "active" },
  { includeArchived: true, title: "complete" },
] as const

for (const scenario of scenarios)
  test(`${scenario.title} bootstrap workflow configuration round-trips into a retargeted Space`, async () => {
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
      const states = await source.sql<
        { readonly category: string; readonly id: string; readonly revision: number }[]
      >`select id,category,revision::integer revision from workflow_states where space_id='delivery'`
      const byCategory = new Map(
        states
          .filter((state) => /^state:[0-9a-f]{64}$/.test(state.id))
          .map((state) => [state.category, state]),
      )
      const backlog = requiredState(byCategory, "backlog")
      const started = requiredState(byCategory, "started")
      const completed = requiredState(byCategory, "completed")
      const replacement = await command(
        source.request,
        "/spaces/delivery/workflow/states",
        "POST",
        null,
        {
          name: "Shipped",
          category: "completed",
          color: "#15803D",
          position: 5,
          isDefault: false,
        },
        "completed-replacement",
      )
      assert.equal(replacement.status, 201, await replacement.clone().text())
      await patchState(
        source.request,
        backlog.id,
        backlog.revision,
        { position: 10 },
        "backlog-temp",
      )
      await patchState(
        source.request,
        started.id,
        started.revision,
        { position: 0 },
        "started-move",
      )
      await patchState(
        source.request,
        backlog.id,
        backlog.revision + 1,
        { name: "Ideas", color: "#123456", position: 2 },
        "backlog-edit",
      )
      const archived = await command(
        source.request,
        `/spaces/delivery/workflow/states/${completed.id}/archive`,
        "POST",
        completed.revision,
        {},
        "archive-completed",
      )
      assert.equal(archived.status, 200, await archived.clone().text())
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
        body: JSON.stringify({ includeArchived: scenario.includeArchived, spaceId: "delivery" }),
      })
      const sourceBytes = await exported.text()
      assert.equal(exported.status, 200, sourceBytes)
      assert.equal(exportedWorkflowScope(sourceBytes), scenario.includeArchived ? "all" : "active")
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
      const replay = await validateAndCommit(
        destination.request,
        bytes,
        "11111111-1111-4111-8111-111111111111",
      )
      assert.equal(replay.commit?.status, 200, await replay.commit?.clone().text())
      assert.equal(
        z.object({ replayed: z.boolean() }).parse(await replay.commit?.json()).replayed,
        true,
      )
      const restored = await destination.request("/api/human/v1/workspaces/w/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          includeArchived: scenario.includeArchived,
          spaceId: "restored-delivery",
        }),
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
      const [counts] = await destination.sql<
        { readonly active: number; readonly total: number }[]
      >`select count(*) filter (where active)::integer active,count(*)::integer total
      from workflow_states where space_id='restored-delivery'`
      assert.deepEqual(counts, {
        active: 5,
        total: scenario.includeArchived ? 6 : 5,
      })
      const [evidence] = await destination.sql<
        { readonly actors: number; readonly events: number }[]
      >`select count(*)::integer events,count(*) filter (where actor_id='owner')::integer actors
      from entity_events_v1 where subject_kind='workflow_state'`
      assert.deepEqual(
        evidence,
        scenario.includeArchived ? { actors: 12, events: 12 } : { actors: 10, events: 10 },
      )
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

function workflowAttributes(bytes: string) {
  return bytes
    .trimEnd()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
    .filter((record) => Reflect.get(record, "kind") === "workflow_state")
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

function exportedWorkflowScope(bytes: string): unknown {
  const space = bytes
    .trimEnd()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
    .find((record) => Reflect.get(record, "kind") === "space")
  return space === undefined ? undefined : Reflect.get(space, "workflowStateScope")
}
