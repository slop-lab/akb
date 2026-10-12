import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { HumanQueryService } from "../src/human-query/service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import type { CommandCall } from "../src/pm/commands/types.ts"
import { createSearchFixture, type SearchFixture } from "./postgres-r4-search-fixture.ts"

let fixture: SearchFixture
let queries: HumanQueryService
let stateId: string
let firstParentId: string
let secondParentId: string
let childId: string

beforeEach(async () => {
  fixture = await createSearchFixture()
  queries = new HumanQueryService(fixture.database.sql, randomBytes(32))
  await fixture.execute("space.create", null, null, null, {
    id: "public",
    key: "PUB",
    name: "Public",
    visibility: "public",
    description: "",
    icon: null,
    leadId: null,
  })
  const [state] = await fixture.database.sql<{ readonly id: string }[]>`
    select id from workflow_states where workspace_id='search' and space_id='public' and is_default`
  if (state === undefined) throw new TypeError("fixture workflow state missing")
  stateId = state.id
  firstParentId = await fixture.createWork("public", stateId, "Alpha parent", "alpha")
  secondParentId = await fixture.createWork("public", stateId, "Beta parent", "beta")
  childId = await fixture.createWork("public", stateId, "Zulu child", "child")
})

afterEach(async () => fixture.database.close())

test("Work detail reflects a parent relation addition immediately", async () => {
  // Given
  assert.equal((await detail(childId))?.parentId, null)

  // When
  await relation("relation.create", null, {
    fromEntityId: firstParentId,
    relationType: "parent_of",
    toEntityId: childId,
  })

  // Then
  assert.equal((await detail(childId))?.parentId, firstParentId)
})

test("Work detail reflects a parent relation removal immediately", async () => {
  // Given
  const relationId = await relation("relation.create", null, {
    fromEntityId: firstParentId,
    relationType: "parent_of",
    toEntityId: childId,
  })

  // When
  await relation("relation.archive", relationId, {})

  // Then
  assert.equal((await detail(childId))?.parentId, null)
})

test("Work query continuation freezes parent relation at snapshot creation", async () => {
  // Given
  const relationId = await relation("relation.create", null, {
    fromEntityId: firstParentId,
    relationType: "parent_of",
    toEntityId: childId,
  })
  const query = {
    model: "r4",
    filter: null,
    search: null,
    sort: [{ field: "title", direction: "asc" }],
    includeArchived: false,
    page: { size: 2, cursor: null },
  } as const
  const firstPage = await queries.queryWorkItems(fixture.owner, "search", query)
  if (firstPage.nextCursor === null) throw new TypeError("fixture continuation missing")
  await relation("relation.archive", relationId, {})
  await relation("relation.create", null, {
    fromEntityId: secondParentId,
    relationType: "parent_of",
    toEntityId: childId,
  })

  // When
  const continuation = await queries.queryWorkItems(fixture.owner, "search", {
    ...query,
    page: { size: 2, cursor: firstPage.nextCursor },
  })

  // Then
  assert.equal(continuation.items[0]?.id, childId)
  assert.equal(continuation.items[0]?.parentId, firstParentId)
})

test("Project parents require project read authority", async () => {
  // Given
  const projectId = await project()
  await relation("relation.create", null, {
    fromEntityId: projectId,
    relationType: "parent_of",
    toEntityId: childId,
  })
  await new IdentityAdmin(fixture.database.sql).setPermissions({
    workspaceId: "search",
    principalId: "viewer",
    permissions: ["work.read", "space.read"],
  })

  // When
  const [ownerDetail, viewerDetail] = await Promise.all([
    detail(childId),
    queries.getWorkItem(fixture.viewer, "search", childId),
  ])

  // Then
  assert.equal(ownerDetail?.parentId, projectId)
  assert.equal(viewerDetail?.parentId, null)
})

function detail(id: string) {
  return queries.getWorkItem(fixture.owner, "search", id)
}

async function relation(
  action: "relation.create" | "relation.archive",
  resourceId: string | null,
  payload: unknown,
): Promise<string> {
  const result = await command(action, resourceId, resourceId === null ? null : 1, payload)
  const id = Reflect.get(result.result, "id")
  if (typeof id !== "string") throw new TypeError("relation ID missing")
  return id
}

async function project(): Promise<string> {
  const result = await command("project.create", null, null, {
    name: "Project parent",
    slug: "project-parent",
    summary: "",
    ownerId: "owner",
    leadIds: [],
    participatingSpaceIds: ["public"],
    state: "active",
    health: "on_track",
    priority: "none",
    startDate: null,
    targetDate: null,
  })
  const id = Reflect.get(result.result, "id")
  if (typeof id !== "string") throw new TypeError("project ID missing")
  return id
}

function command(
  action: CommandCall["action"],
  resourceId: string | null,
  baseRevision: number | null,
  payload: unknown,
) {
  const key = randomUUID()
  return fixture.commands.execute({
    workspaceId: "search",
    principal: fixture.owner,
    commandId: key,
    idempotencyKey: key,
    baseRevision,
    action,
    route: action,
    resourceId,
    parentId: null,
    payload,
  })
}
