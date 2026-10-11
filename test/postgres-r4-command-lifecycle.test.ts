import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { WORK_PERMISSIONS } from "../src/identity/types.ts"
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

test("all 27 command routes persist complete resource lifecycles", async () => {
  // Given
  const statuses: number[] = []
  const execute = async (
    path: string,
    method: "POST" | "PATCH" | "PUT",
    revision: number | null,
    payload: unknown,
    key: string,
  ) => {
    const response = await api.send(path, method, revision, payload, key)
    statuses.push(response.status)
    return response.body
  }
  const spacePayload = {
    id: "engineering",
    key: "ENG",
    name: "Engineering",
    visibility: "private",
    description: "",
    icon: null,
    leadId: "owner",
  }

  // When
  await execute("/spaces", "POST", null, spacePayload, "space-create")
  await execute("/spaces/engineering", "PATCH", 1, { name: "Product Engineering" }, "space-update")
  await execute(
    "/spaces/engineering/access",
    "PUT",
    2,
    { principalId: "owner", permissions: WORK_PERMISSIONS },
    "space-access",
  )
  const workflowRows = await fixture.sql<{ readonly id: string }[]>`
    select id from workflows where workspace_id='w' and space_id='engineering'`
  const workflowId = requiredId(workflowRows[0]?.id)
  await execute("/spaces/engineering/workflow", "PATCH", 1, { name: "Delivery" }, "workflow-update")
  const stateBody = await execute(
    "/spaces/engineering/workflow/states",
    "POST",
    null,
    { name: "Review", category: "started", color: "#2563EB", position: 10, isDefault: false },
    "state-create",
  )
  const stateId = resultId(stateBody)
  await execute(
    `/spaces/engineering/workflow/states/${stateId}`,
    "PATCH",
    1,
    { name: "In review", position: 11 },
    "state-update",
  )
  await execute(
    `/spaces/engineering/workflow/states/${stateId}/archive`,
    "POST",
    2,
    {},
    "state-archive",
  )
  const labelBody = await execute(
    "/spaces/engineering/labels",
    "POST",
    null,
    { name: "Backend", color: "blue" },
    "label-create",
  )
  const labelId = resultId(labelBody)
  await execute(
    `/labels/${labelId}`,
    "PATCH",
    1,
    { name: "Platform", color: "navy" },
    "label-update",
  )
  const projectBody = await execute(
    "/projects",
    "POST",
    null,
    {
      name: "Launch",
      slug: "launch",
      summary: "Ship product",
      ownerId: "owner",
      leadIds: ["owner"],
      participatingSpaceIds: ["engineering"],
      state: "active",
      health: "on_track",
      priority: "high",
      startDate: "2026-01-01",
      targetDate: "2026-02-01",
    },
    "project-create",
  )
  const projectId = resultId(projectBody)
  await execute(
    `/projects/${projectId}`,
    "PATCH",
    1,
    { summary: "Ship safely", targetDate: "2026-03-01" },
    "project-update",
  )
  await execute(`/projects/${projectId}/archive`, "POST", 2, {}, "project-archive")
  await execute(`/projects/${projectId}/restore`, "POST", 3, {}, "project-restore")
  const defaultStates = await fixture.sql<{ readonly id: string }[]>`
    select id from workflow_states where workflow_id=${workflowId} and category='unstarted' and active`
  const defaultStateId = requiredId(defaultStates[0]?.id)
  const workBody = await execute(
    "/work-items",
    "POST",
    null,
    {
      spaceId: "engineering",
      title: "Ship",
      accountableOwnerId: "owner",
      description: "Release",
      type: "Task",
      workflowStateId: defaultStateId,
      projectId,
      priority: "urgent",
      labelIds: [labelId],
      startDate: "2026-01-02",
      dueDate: "2026-01-31",
    },
    "work-create",
  )
  const workId = resultId(workBody)
  await execute(
    `/work-items/${workId}`,
    "PATCH",
    1,
    { title: "Ship safely", description: "Release safely", priority: "high" },
    "work-update",
  )
  await execute(`/work-items/${workId}/archive`, "POST", 2, {}, "work-archive")
  await execute(`/work-items/${workId}/restore`, "POST", 3, {}, "work-restore")
  await execute(`/labels/${labelId}/archive`, "POST", 2, {}, "label-archive")
  const relationBody = await execute(
    "/relations",
    "POST",
    null,
    { fromEntityId: projectId, relationType: "supports", toEntityId: workId },
    "relation-create",
  )
  const relationId = resultId(relationBody)
  await execute(
    `/relations/${relationId}`,
    "PATCH",
    1,
    { relationType: "blocks" },
    "relation-update",
  )
  await execute(`/relations/${relationId}/archive`, "POST", 2, {}, "relation-archive")
  const commentBody = await execute(
    `/entities/${workId}/comments`,
    "POST",
    null,
    { body: "Initial note" },
    "comment-create",
  )
  const commentId = resultId(commentBody)
  await execute(`/comments/${commentId}`, "PATCH", 1, { body: "Updated note" }, "comment-update")
  const definition = {
    model: "r4",
    filter: null,
    search: null,
    sort: [{ field: "updatedAt", direction: "desc" }],
    includeArchived: false,
    page: { size: 50, cursor: null },
  }
  const viewBody = await execute(
    "/saved-views",
    "POST",
    null,
    { name: "Mine", access: "private", scopeSpaceId: null, definition },
    "view-create",
  )
  const viewId = resultId(viewBody)
  await execute(`/saved-views/${viewId}`, "PATCH", 1, { name: "My work" }, "view-update")
  await execute(`/saved-views/${viewId}/archive`, "POST", 2, {}, "view-archive")
  await execute(
    `/entities/${projectId}/access`,
    "PUT",
    4,
    {
      mode: "restricted",
      allowances: [
        { principalId: "owner", permissions: ["project.read", "project.manage", "acl.manage"] },
      ],
    },
    "entity-access",
  )

  // Then
  assert.deepEqual(
    statuses,
    [
      201, 200, 200, 200, 201, 200, 200, 201, 200, 201, 200, 200, 200, 201, 200, 200, 200, 200, 201,
      200, 200, 201, 200, 201, 200, 200, 200,
    ],
  )
  const evidence = await fixture.sql`select
    (select count(*)::integer from entity_events_v1) events,
    (select count(*)::integer from entity_outbox_events_v1) outbox,
    (select count(*)::integer from domain_events where subject_id=${workId}) legacy,
    (select count(*)::integer from search_documents) search,
    (select source_revision::integer from search_documents where entity_id=${projectId}) project_search,
    (select source_revision::integer from search_documents where entity_id=${workId}) work_search,
    (select source_revision::integer from search_documents where entity_id=${commentId}) comment_search,
    (select document::text from search_documents where entity_id=${projectId}) project_document,
    (select document::text from search_documents where entity_id=${workId}) work_document,
    (select document::text from search_documents where entity_id=${commentId}) comment_document,
    (select priority from work_item_pm where work_item_id=${workId}) priority,
    (select state from work_items where id=${workId}) category`
  assert.deepEqual(
    [...evidence],
    [
      {
        events: 27,
        outbox: 27,
        legacy: 4,
        search: 3,
        project_search: 4,
        work_search: 4,
        comment_search: 2,
        project_document: "'launch':1,2 'safely':4 'ship':3",
        work_document: "'release':3 'safely':2,4 'ship':1",
        comment_document: "'note':2 'updated':1",
        priority: "high",
        category: "unstarted",
      },
    ],
  )
})

function requiredId(value: string | undefined): string {
  if (value === undefined) throw new TypeError("fixture ID is missing")
  return value
}
