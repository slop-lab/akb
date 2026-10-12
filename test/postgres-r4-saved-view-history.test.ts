import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { HistoryEntrySchema } from "../src/contracts/r4/index.ts"
import type { FilterNode, HumanWorkQuery } from "../src/contracts/r4/query.ts"
import { HumanReadService } from "../src/human-query/read-service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import type { CommandCall } from "../src/pm/commands/types.ts"
import { createSearchFixture, type SearchFixture } from "./postgres-r4-search-fixture.ts"

let fixture: SearchFixture
let reads: HumanReadService
let stateId: string

beforeEach(async () => {
  fixture = await createSearchFixture()
  reads = new HumanReadService(fixture.database.sql)
  await new IdentityAdmin(fixture.database.sql).setPermissions({
    workspaceId: "search",
    principalId: "viewer",
    permissions: ["work.read", "space.read", "project.read", "view.read", "history.read"],
  })
  await fixture.execute("space.create", null, null, null, {
    id: "public",
    key: "PUB",
    name: "Public",
    visibility: "public",
    description: "",
    icon: null,
    leadId: null,
  })
  const sql = fixture.database.sql
  await sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at) values
    ('project','search','project',null,1,'owner',now(),now()),
    ('label','search','label','public',1,'owner',now(),now())`
  await sql`insert into entity_acl_policies values ('project','inherit'),('label','inherit')`
  const [state] = await sql<{ readonly id: string }[]>`
    select id from workflow_states where workspace_id='search' and space_id='public' and is_default`
  if (state === undefined) throw new TypeError("fixture workflow state missing")
  stateId = state.id
})

afterEach(async () => fixture.database.close())

test("Saved View history preserves readable definitions for each revision", async () => {
  const first = definition(
    { op: "range", field: "projectId", from: "project", to: "project" },
    "First search",
  )
  const second = definition(
    { op: "range", field: "labelId", from: null, to: "zzzz" },
    "Current search",
  )
  const id = await createView(first)
  await command("saved-view.update", { definition: second }, { id, revision: 1 })

  const [rawHistory, views] = await Promise.all([
    reads.history(fixture.viewer, id),
    reads.savedViews(fixture.viewer),
  ])
  const history = HistoryEntrySchema.array().parse(rawHistory)

  assert.deepEqual(
    history.map((entry) => Reflect.get(entry.snapshot, "definition")),
    [second, first],
  )
  assert.deepEqual(Reflect.get(views[0] ?? {}, "definition"), second)
})

for (const field of ["projectId", "workflowStateId", "labelId", "spaceId"] as const) {
  test(`Saved View history removes definitions with unreadable ${field} references`, async () => {
    const value = {
      projectId: "project",
      workflowStateId: stateId,
      labelId: "label",
      spaceId: "public",
    }[field]
    const first = definition({ op: "eq", field, value }, "Historical search")
    const current = definition(null, "Readable search")
    const id = await createView(first)
    await command("saved-view.update", { definition: current }, { id, revision: 1 })
    await fixture.database.sql`update entity_acl_policies set mode='restricted'
      where entity_id=case when ${field}='spaceId'
        then stable_space_entity_id('search',${value}) else ${value} end`

    const history = HistoryEntrySchema.array().parse(await reads.history(fixture.viewer, id))

    assert.equal(history.length, 2)
    assert.equal(Object.hasOwn(history[1]?.snapshot ?? {}, "definition"), false)
    assert.deepEqual(Reflect.get(history[0]?.snapshot ?? {}, "definition"), current)
  })
}

test("Saved View history rechecks nested filter references after permission removal", async () => {
  const filter = {
    op: "and",
    filters: [{ op: "not", filter: { op: "in", field: "projectId", values: ["project"] } }],
  } as const
  const id = await createView(definition(filter, "Historical search"))
  await new IdentityAdmin(fixture.database.sql).setPermissions({
    workspaceId: "search",
    principalId: "viewer",
    permissions: ["work.read", "space.read", "view.read", "history.read"],
  })

  const history = HistoryEntrySchema.array().parse(await reads.history(fixture.viewer, id))

  assert.equal(Object.hasOwn(history[0]?.snapshot ?? {}, "definition"), false)
})

function definition(filter: FilterNode | null, search: string): HumanWorkQuery {
  return {
    model: "r4",
    filter,
    search,
    sort: [{ field: "updatedAt", direction: "desc" }],
    includeArchived: false,
    page: { size: 50, cursor: null },
  }
}

async function createView(value: HumanWorkQuery): Promise<string> {
  const result = await command("saved-view.create", {
    name: "History fixture",
    access: "workspace",
    scopeSpaceId: null,
    definition: value,
  })
  const id = Reflect.get(result.result, "id")
  if (typeof id !== "string") throw new TypeError("fixture Saved View ID missing")
  return id
}

function command(
  action: CommandCall["action"],
  payload: unknown,
  target?: { readonly id: string; readonly revision: number },
) {
  const key = randomUUID()
  return fixture.commands.execute({
    workspaceId: "search",
    principal: fixture.owner,
    commandId: key,
    idempotencyKey: key,
    baseRevision: target?.revision ?? null,
    action,
    route: action,
    resourceId: target?.id ?? null,
    parentId: null,
    payload,
  })
}
