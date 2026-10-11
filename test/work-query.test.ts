import assert from "node:assert/strict"
import test from "node:test"
import {
  applyWorkQueryDraft,
  createWorkQueryDraft,
  hydrateWorkQueryDraft,
} from "../apps/web/src/features/work/work-query.ts"
import type { HumanWorkQuery } from "../src/contracts/r4/index.ts"

test("applied work query combines Space with every structured filter", () => {
  const draft = createWorkQueryDraft("space-1")

  const query = applyWorkQueryDraft(
    {
      ...draft,
      projectId: "project-1",
      workflowStateId: "state-1",
      stateCategory: "started",
      accountableOwnerId: "owner-1",
      priority: "high",
      type: "task",
      labelId: "label-1",
      startDateFrom: "2026-10-01",
      startDateTo: "2026-10-31",
      dueDateFrom: "2026-11-01",
      dueDateTo: "2026-11-30",
      includeArchived: true,
      search: " release ",
      sortField: "dueDate",
      sortDirection: "asc",
    },
    "list",
  )

  assert.deepEqual(query, {
    model: "r4",
    filter: {
      op: "and",
      filters: [
        { op: "eq", field: "spaceId", value: "space-1" },
        { op: "eq", field: "projectId", value: "project-1" },
        { op: "eq", field: "workflowStateId", value: "state-1" },
        { op: "eq", field: "stateCategory", value: "started" },
        { op: "eq", field: "accountableOwnerId", value: "owner-1" },
        { op: "eq", field: "priority", value: "high" },
        { op: "eq", field: "type", value: "task" },
        { op: "eq", field: "labelId", value: "label-1" },
        { op: "range", field: "startDate", from: "2026-10-01", to: "2026-10-31" },
        { op: "range", field: "dueDate", from: "2026-11-01", to: "2026-11-30" },
      ],
    },
    search: "release",
    sort: [{ field: "dueDate", direction: "asc" }],
    includeArchived: true,
    page: { size: 50, cursor: null },
  })
})

test("saved view hydration preserves a complex definition until a control changes", () => {
  const definition: HumanWorkQuery = {
    model: "r4",
    filter: {
      op: "or",
      filters: [
        { op: "eq", field: "priority", value: "urgent" },
        { op: "relation", relationType: "blocks", entityId: "work-2" },
      ],
    },
    search: "incident",
    sort: [{ field: "priority", direction: "desc" }],
    includeArchived: false,
    page: { size: 17, cursor: null },
  }

  const hydrated = hydrateWorkQueryDraft(definition, "space-1")

  assert.equal(hydrated.source, definition)
  assert.equal(applyWorkQueryDraft(hydrated, "list"), definition)
})
