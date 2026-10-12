import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { HumanQueryService, QueryBudgetExceededError } from "../src/human-query/service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import {
  type ContinuationFixture,
  createContinuationFixture,
} from "./postgres-r4-continuation-fixture.ts"

const surfaces = ["work", "project", "board", "search"] as const
const BudgetErrorSchema = z.object({
  error: z.object({ code: z.literal("query_budget_exceeded") }),
})
let runtime: ContinuationFixture

beforeEach(async () => {
  runtime = await createContinuationFixture()
})

afterEach(async () => runtime.close())

for (const surface of surfaces) {
  test(`${surface} returns typed 507 when the principal snapshot quota is exhausted`, async () => {
    for (let index = 0; index < 8; index++) {
      assert.equal((await runtime.emptyPage(surface)).status, 200)
    }

    const denied = await runtime.emptyPage(surface)

    assert.equal(denied.status, 507)
    assert.equal(BudgetErrorSchema.parse(await denied.json()).error.code, "query_budget_exceeded")
    assert.deepEqual(await snapshotBudget(), { count: 8, matched: 0 })
  })
}

test("concurrent query surfaces allocate only the last available principal snapshot", async () => {
  for (let index = 0; index < 7; index++) {
    assert.equal((await runtime.emptyPage("work")).status, 200)
  }

  const responses = await Promise.all(surfaces.map((surface) => runtime.emptyPage(surface)))

  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 507, 507, 507])
  for (const response of responses.filter((value) => value.status === 507)) {
    assert.equal(BudgetErrorSchema.parse(await response.json()).error.code, "query_budget_exceeded")
  }
  assert.deepEqual(await snapshotBudget(), { count: 8, matched: 0 })
})

test("workspace row exhaustion returns typed 507 on every query surface without allocation", async () => {
  await reserveRows([100_000, 100_000, 49_999])

  const responses = await Promise.all(surfaces.map((surface) => runtime.firstPage(surface)))

  assert.deepEqual(
    responses.map((response) => response.status),
    [507, 507, 507, 507],
  )
  for (const response of responses) {
    assert.equal(BudgetErrorSchema.parse(await response.json()).error.code, "query_budget_exceeded")
  }
  assert.deepEqual(await snapshotBudget(), { count: 3, matched: 249_999 })
})

test("workspace snapshot rows are reserved atomically across different principals", async () => {
  const fixture = runtime.fixture
  await new IdentityAdmin(fixture.database.sql).setPermissions({
    workspaceId: "search",
    principalId: "viewer",
    permissions: ["work.read", "space.read", "project.read"],
  })
  await reserveRows([100_000, 100_000, 49_997])
  const query = {
    model: "r4",
    filter: null,
    search: "frozen",
    sort: [{ field: "title", direction: "asc" }],
    includeArchived: false,
    page: { size: 1, cursor: null },
  } as const
  const service = new HumanQueryService(fixture.database.sql, fixture.signingKey)

  const results = await Promise.allSettled([
    service.queryWorkItems(fixture.owner, "search", query),
    service.queryWorkItems(fixture.viewer, "search", query),
  ])

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  const rejected = results.find((result) => result.status === "rejected")
  assert.equal(
    rejected?.status === "rejected" && rejected.reason instanceof QueryBudgetExceededError,
    true,
  )
  assert.deepEqual(await snapshotBudget(), { count: 4, matched: 249_999 })
})

async function reserveRows(matches: readonly number[]): Promise<void> {
  const { database, owner } = runtime.fixture
  const hash = "a".repeat(64)
  for (const matched of matches) {
    await database.sql`insert into human_query_snapshots
      (workspace_id,principal_id,credential_id,query_hash,sort_hash,authority_hash,matched,expires_at)
      values (${owner.workspaceId},${owner.principalId},${owner.credentialId},
        ${hash},${hash},${hash},${matched},clock_timestamp()+interval '10 minutes')`
  }
}

async function snapshotBudget() {
  const [budget] = await runtime.fixture.database.sql`
    select count(*)::integer count,coalesce(sum(matched),0)::integer matched
    from human_query_snapshots where expires_at>clock_timestamp()`
  return budget
}
