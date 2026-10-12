import assert from "node:assert/strict"
import { test } from "node:test"
import type { BoardRequest, HumanWorkQuery, WorkItemDetail } from "../src/contracts/r4/index.ts"
import {
  createLegacyWorkFixture,
  immutableWorkRecords,
  type LegacyWorkFixture,
} from "./postgres-r4-legacy-work-query-fixture.ts"

test("upgraded legacy Work projects through detail, list, board, and frozen continuations", async (context) => {
  // Given
  const fixture = await createLegacyWorkFixture(context)
  const listRequest = workQuery(null)
  const boardRequest = boardQuery(null, null)
  const [detailR1, listR1, boardR1] = await Promise.all([
    fixture.query.getWorkItem(fixture.principal, "legacy", fixture.zuluId),
    fixture.query.queryWorkItems(fixture.principal, "legacy", listRequest),
    fixture.board.query(fixture.principal, "legacy", boardRequest),
  ])
  const listCursor = required(listR1.nextCursor)
  const boardColumnR1 = required(
    boardR1.columns.find((column) => column.state.id === fixture.stateId),
  )
  const boardCursor = required(boardColumnR1.nextCursor)
  assertLegacyProjection(detailR1, fixture)
  const captured = await fixture.database.sql<
    { readonly entity_id: string; readonly legacy_work_pm_projection: unknown }[]
  >`select entity_id,legacy_work_pm_projection from human_query_snapshot_items
    where snapshot_id in (${listR1.snapshot.id}::uuid,${boardR1.snapshot.id}::uuid)
      and entity_id=${fixture.zuluId} order by snapshot_id`
  assert.equal(captured.length, 2)
  assert.deepEqual(captured[0]?.legacy_work_pm_projection, captured[1]?.legacy_work_pm_projection)
  assert.deepEqual(captured[0]?.legacy_work_pm_projection, {
    _schema: "legacy-work-pm-query.v1",
    sequence: 2,
    workflow_state_id: fixture.stateId,
    project_id: fixture.projectId,
    description: "Frozen description",
    item_type: "Bug",
    priority: "high",
    start_date: "2026-01-10",
    due_date: "2026-01-20",
    completed_at: null,
    archived_at: null,
    labelIds: [fixture.labelId],
  })

  await updateReferences(fixture)
  await fixture.commands.execute({
    workspaceId: "legacy",
    principal: fixture.principal,
    commandId: "work-r2",
    idempotencyKey: "work-r2",
    baseRevision: 1,
    action: "work-item.update",
    route: "work-item.update",
    resourceId: fixture.zuluId,
    parentId: null,
    payload: { title: "Zulu R2", description: "Current description", priority: "urgent" },
  })

  // When
  const [continuedList, continuedBoard, detailR2, currentList] = await Promise.all([
    fixture.query.queryWorkItems(fixture.principal, "legacy", workQuery(listCursor)),
    fixture.board.query(fixture.principal, "legacy", boardQuery(boardCursor, fixture.stateId)),
    fixture.query.getWorkItem(fixture.principal, "legacy", fixture.zuluId),
    fixture.query.queryWorkItems(fixture.principal, "legacy", {
      ...workQuery(null),
      search: "Zulu R2",
    }),
  ])

  // Then
  const frozenListItem = required(continuedList.items[0])
  const frozenBoardItem = required(continuedBoard.columns[0]?.cards[0])
  assertLegacyProjection(frozenListItem, fixture)
  assert.deepEqual(frozenBoardItem, frozenListItem)
  assert.equal(continuedList.nextCursor, null)
  assert.equal(continuedBoard.columns[0]?.nextCursor, null)
  assert.equal(detailR2?.revision, 2)
  assert.equal(detailR2?.title, "Zulu R2")
  assert.equal(detailR2?.description, "Current description")
  assert.equal(detailR2?.priority, "urgent")
  assert.deepEqual(detailR2?.project, { id: fixture.projectId, name: "Current project" })
  assert.deepEqual(detailR2?.labels, [{ id: fixture.labelId, name: "Current label" }])
  assert.deepEqual(
    currentList.items.map((item) => [item.revision, item.title]),
    [[2, "Zulu R2"]],
  )
  const currentMembers = await fixture.database.sql`select legacy_work_pm_projection from
    human_query_snapshot_items where snapshot_id=${currentList.snapshot.id}::uuid`
  assert.deepEqual([...currentMembers], [{ legacy_work_pm_projection: null }])
  assert.deepEqual(
    await immutableWorkRecords(fixture.database.sql, [fixture.alphaId, fixture.zuluId]),
    fixture.immutableBefore,
  )
  assert.deepEqual(
    captured,
    await fixture.database.sql`select entity_id,legacy_work_pm_projection
      from human_query_snapshot_items
      where snapshot_id in (${listR1.snapshot.id}::uuid,${boardR1.snapshot.id}::uuid)
        and entity_id=${fixture.zuluId} order by snapshot_id`,
  )
})

test("legacy snapshot sidecars fail closed when missing or malformed", async (context) => {
  // Given
  const fixture = await createLegacyWorkFixture(context)
  const first = await fixture.query.queryWorkItems(fixture.principal, "legacy", workQuery(null))
  const cursor = required(first.nextCursor)
  await fixture.database.sql`update human_query_snapshot_items
    set legacy_work_pm_projection=legacy_work_pm_projection-'description'
    where snapshot_id=${first.snapshot.id}::uuid and entity_id=${fixture.zuluId}`

  // When / Then
  await assert.rejects(fixture.query.queryWorkItems(fixture.principal, "legacy", workQuery(cursor)))
  await fixture.database.sql`update human_query_snapshot_items set legacy_work_pm_projection=null
    where snapshot_id=${first.snapshot.id}::uuid and entity_id=${fixture.zuluId}`
  const missing = await fixture.query.queryWorkItems(fixture.principal, "legacy", workQuery(cursor))
  assert.deepEqual(missing.items, [])
  await assert.rejects(
    fixture.database.sql`update human_query_snapshot_items
      set legacy_work_pm_projection=jsonb_build_object('_schema','wrong')
      where snapshot_id=${first.snapshot.id}::uuid and entity_id=${fixture.zuluId}`,
  )
})

function workQuery(cursor: string | null): HumanWorkQuery {
  return {
    model: "r4",
    filter: { op: "eq", field: "spaceId", value: "old" },
    search: null,
    sort: [{ field: "title", direction: "asc" }],
    includeArchived: false,
    page: { size: 1, cursor },
  }
}

function boardQuery(cursor: string | null, workflowStateId: string | null): BoardRequest {
  return { ...workQuery(cursor), workflowStateId }
}

async function updateReferences(fixture: LegacyWorkFixture): Promise<void> {
  await fixture.commands.execute({
    workspaceId: "legacy",
    principal: fixture.principal,
    commandId: "project-r2",
    idempotencyKey: "project-r2",
    baseRevision: 1,
    action: "project.update",
    route: "project.update",
    resourceId: fixture.projectId,
    parentId: null,
    payload: { name: "Current project" },
  })
  await fixture.commands.execute({
    workspaceId: "legacy",
    principal: fixture.principal,
    commandId: "label-r2",
    idempotencyKey: "label-r2",
    baseRevision: 1,
    action: "label.update",
    route: "label.update",
    resourceId: fixture.labelId,
    parentId: null,
    payload: { name: "Current label" },
  })
}

function assertLegacyProjection(
  item: WorkItemDetail | undefined,
  fixture: LegacyWorkFixture,
): void {
  if (item === undefined) assert.fail("legacy projection missing")
  assert.equal(item.revision, 1)
  assert.equal(item.title, "Zulu legacy")
  assert.equal(item.description, "Frozen description")
  assert.equal(item.type, "Bug")
  assert.equal(item.priority, "high")
  assert.deepEqual(item.project, { id: fixture.projectId, name: "Legacy project" })
  assert.deepEqual(item.labels, [{ id: fixture.labelId, name: "Legacy label" }])
  assert.equal(item.startDate, "2026-01-10")
  assert.equal(item.dueDate, "2026-01-20")
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new TypeError("required test value missing")
  return value
}
