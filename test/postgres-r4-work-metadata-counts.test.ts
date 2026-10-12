import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import type { FilterNode } from "../src/contracts/r4/query.ts"
import { HumanQueryService } from "../src/human-query/service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createSearchFixture, type SearchFixture } from "./postgres-r4-search-fixture.ts"

type WorkPair = {
  readonly visibleWorkId: string
  readonly hiddenWorkId: string
  readonly visibleStateId: string
  readonly hiddenStateId: string
}

type SnapshotCounts = {
  readonly matched: number
  readonly members: number
  readonly entity_ids: string[]
}

let fixture: SearchFixture

beforeEach(async () => {
  fixture = await createSearchFixture()
  await new IdentityAdmin(fixture.database.sql).setPermissions({
    workspaceId: "search",
    principalId: "viewer",
    permissions: ["work.read", "space.read", "project.read"],
  })
})

afterEach(async () => fixture.database.close())

test("Work snapshots exclude work with unreadable Space metadata before all counts", async () => {
  // Given
  const pair = await seedWorkPair()
  await grantPrivateSpace("work.read")
  assert.deepEqual(await authorityFor(pair.hiddenWorkId), {
    work_allowed: true,
    space_allowed: false,
    state_allowed: false,
  })

  // When
  const observations = await queryFilterShapes("spaceId", "visible")

  // Then
  assertAuthorizedOnly(observations, pair.visibleWorkId)
})

test("Work snapshots exclude work with unreadable state metadata before all counts", async () => {
  // Given
  const pair = await seedWorkPair()
  await grantPrivateSpace("work.read")
  await grantPrivateSpace("space.read")
  await fixture.database.sql`update entity_acl_policies set mode='restricted'
    where entity_id=${pair.hiddenStateId}`
  assert.deepEqual(await authorityFor(pair.hiddenWorkId), {
    work_allowed: true,
    space_allowed: true,
    state_allowed: false,
  })

  // When
  const observations = await queryFilterShapes("workflowStateId", pair.visibleStateId)

  // Then
  assertAuthorizedOnly(observations, pair.visibleWorkId)
})

async function seedWorkPair(): Promise<WorkPair> {
  await createSpace("visible", "VIS", "public")
  await createSpace("hidden", "HID", "private")
  const states = await fixture.database.sql<
    { readonly id: string; readonly space_id: string }[]
  >`select id,space_id from workflow_states
    where workspace_id='search' and space_id in ('visible','hidden') and is_default`
  const visibleStateId = requiredState(states, "visible")
  const hiddenStateId = requiredState(states, "hidden")
  const visibleWorkId = await fixture.createWork(
    "visible",
    visibleStateId,
    "Visible metadata",
    "visible-metadata",
  )
  const hiddenWorkId = await fixture.createWork(
    "hidden",
    hiddenStateId,
    "Hidden metadata",
    "hidden-metadata",
  )
  return { visibleWorkId, hiddenWorkId, visibleStateId, hiddenStateId }
}

async function createSpace(
  id: string,
  key: string,
  visibility: "public" | "private",
): Promise<void> {
  await fixture.execute("space.create", null, null, null, {
    id,
    key,
    name: id,
    visibility,
    description: "",
    icon: null,
    leadId: null,
  })
}

async function grantPrivateSpace(permission: "work.read" | "space.read"): Promise<void> {
  await fixture.database.sql`insert into space_permissions
    (workspace_id,space_id,principal_id,permission)
    values ('search','hidden','viewer',${permission})`
}

async function authorityFor(workId: string) {
  const [authority] = await fixture.database.sql<
    {
      readonly work_allowed: boolean
      readonly space_allowed: boolean
      readonly state_allowed: boolean
    }[]
  >`select entity_access_allowed(e.workspace_id,e.id,'viewer','work.read') work_allowed,
      entity_access_allowed(e.workspace_id,stable_space_entity_id(e.workspace_id,pm.space_id),
        'viewer','space.read') space_allowed,
      entity_access_allowed(e.workspace_id,pm.workflow_state_id,'viewer','space.read') state_allowed
    from entities e join work_item_pm pm on pm.work_item_id=e.id where e.id=${workId}`
  if (authority === undefined) throw new TypeError("work authority missing")
  return authority
}

async function queryFilterShapes(field: "spaceId" | "workflowStateId", value: string) {
  const filters = [
    ["null", null],
    [
      "or",
      {
        op: "or",
        filters: [
          { op: "eq", field, value },
          { op: "eq", field: "priority", value: "none" },
        ],
      },
    ],
    ["not", { op: "not", filter: { op: "eq", field: "priority", value: "urgent" } }],
  ] satisfies readonly (readonly [string, FilterNode | null])[]
  return Promise.all(
    filters.map(async ([shape, filter]) => {
      const page = await new HumanQueryService(
        fixture.database.sql,
        fixture.signingKey,
      ).queryWorkItems(fixture.viewer, "search", {
        model: "r4",
        filter,
        search: null,
        sort: [{ field: "createdAt", direction: "asc" }],
        includeArchived: false,
        page: { size: 100, cursor: null },
      })
      const [stored] = await fixture.database.sql<SnapshotCounts[]>`
        select s.matched::integer matched,count(i.entity_id)::integer members,
          coalesce(array_agg(i.entity_id order by i.ordinal)
            filter (where i.entity_id is not null),'{}') entity_ids
        from human_query_snapshots s left join human_query_snapshot_items i on i.snapshot_id=s.id
        where s.id=${page.snapshot.id}::uuid group by s.id`
      if (stored === undefined) throw new TypeError("query snapshot missing")
      return {
        shape,
        itemIds: page.items.map((item) => item.id),
        responseMatched: page.completeness.matched,
        stored,
      }
    }),
  )
}

function assertAuthorizedOnly(
  observations: Awaited<ReturnType<typeof queryFilterShapes>>,
  visibleWorkId: string,
): void {
  assert.deepEqual(
    observations.map(({ shape, itemIds, responseMatched, stored }) => ({
      shape,
      itemIds,
      responseMatched,
      stored,
    })),
    ["null", "or", "not"].map((shape) => ({
      shape,
      itemIds: [visibleWorkId],
      responseMatched: 1,
      stored: { matched: 1, members: 1, entity_ids: [visibleWorkId] },
    })),
  )
}

function requiredState(
  rows: readonly { readonly id: string; readonly space_id: string }[],
  spaceId: string,
): string {
  const stateId = rows.find((row) => row.space_id === spaceId)?.id
  if (stateId === undefined) throw new TypeError(`default state missing for ${spaceId}`)
  return stateId
}
