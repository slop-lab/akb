import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import { HumanWorkQuerySchema } from "../src/contracts/r4/query.ts"
import { HumanQueryService } from "../src/human-query/service.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { completeGraph, ndjson } from "./r4-import-export-fixture.ts"
import { createInterchangeHttpFixture, validateAndCommit } from "./r4-interchange-http-fixture.ts"

let source: Awaited<ReturnType<typeof createInterchangeHttpFixture>>
let destination: Awaited<ReturnType<typeof createInterchangeHttpFixture>>
let standaloneSource: Awaited<ReturnType<typeof createInterchangeHttpFixture>>
let standaloneDestination: Awaited<ReturnType<typeof createInterchangeHttpFixture>>

beforeEach(async () => {
  source = await createInterchangeHttpFixture()
  destination = await createInterchangeHttpFixture()
  standaloneSource = await createInterchangeHttpFixture()
  standaloneDestination = await createInterchangeHttpFixture()
})

afterEach(async () => {
  await source.close()
  await destination.close()
  await standaloneSource.close()
  await standaloneDestination.close()
})

test("Saved View range transfer preserves nullable and unbounded query results", async () => {
  // Given
  const imported = await validateAndCommit(source.request, ndjson(transferGraph()), randomUUID())
  assert.equal(imported.validated.status, 200)
  assert.equal(imported.commit?.status, 200)
  await createNoProjectView(standaloneSource)
  const sourceResults = {
    ...(await queryResults(source)),
    ...(await queryResults(standaloneSource)),
  }

  // When
  for (const [origin, target, spaceId] of [
    [source, destination, "space"],
    [standaloneSource, standaloneDestination, null],
  ] as const) {
    const exported = await origin.request("/api/human/v1/workspaces/w/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeArchived: true, ...(spaceId === null ? {} : { spaceId }) }),
    })
    const bytes = await exported.text()
    assert.equal(exported.status, 200, bytes)
    const restored = await validateAndCommit(target.request, bytes, randomUUID())
    assert.equal(restored.validated.status, 200)
    assert.equal(
      restored.commit?.status,
      200,
      `${spaceId}: ${await restored.commit?.clone().text()}`,
    )
  }
  const destinationResults = {
    ...(await queryResults(destination)),
    ...(await queryResults(standaloneDestination)),
  }

  // Then
  assert.deepEqual(destinationResults, sourceResults)
  assert.deepEqual(sourceResults, {
    "negated-zero": ["Imported work", "Parent"],
    "no-project-graph": [],
    unbounded: ["Imported work", "No project", "Parent"],
    zero: [],
  })
})

function transferGraph(): readonly Readonly<Record<string, unknown>>[] {
  const base = completeGraph("11111111-1111-4111-8111-111111111111").filter(
    (record) => Reflect.get(record, "kind") !== "saved_view",
  )
  return [
    ...base,
    work("no-project", "space", "state", "No project"),
    view("zero", "space", { op: "range", field: "projectId", from: "z", to: "zz" }),
    view("negated-zero", "space", {
      op: "not",
      filter: { op: "range", field: "projectId", from: "z", to: "zz" },
    }),
    view("unbounded", "space", {
      op: "range",
      field: "projectId",
      from: null,
      to: null,
    }),
  ]
}

async function createNoProjectView(
  fixture: Awaited<ReturnType<typeof createInterchangeHttpFixture>>,
): Promise<void> {
  const key = randomUUID()
  const response = await fixture.request("/api/commands/v1/workspaces/w/saved-views", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandId: key,
      idempotencyKey: key,
      baseRevision: null,
      payload: {
        name: "no-project-graph",
        access: "private",
        scopeSpaceId: null,
        definition: definition({
          op: "range",
          field: "projectId",
          from: "z",
          to: "zz",
        }),
      },
    }),
  })
  assert.equal(response.status, 201, await response.text())
}

function work(externalId: string, spaceId: string, stateId: string, title: string) {
  return {
    kind: "work_item",
    externalId,
    spaceId,
    title,
    ownerId: "owner",
    stateId,
    projectId: null,
  }
}

function view(name: string, spaceId: string, range: Readonly<Record<string, unknown>>) {
  return {
    kind: "saved_view",
    externalId: `view-${name}`,
    ownerId: "owner",
    name,
    access: "space",
    scopeSpaceId: spaceId,
    definition: definition(range),
  }
}

function definition(filter: Readonly<Record<string, unknown>>) {
  return {
    model: "r4",
    filter,
    search: null,
    sort: [{ field: "updatedAt", direction: "desc" }],
    includeArchived: false,
    page: { size: 50, cursor: null },
  }
}

async function queryResults(
  fixture: Awaited<ReturnType<typeof createInterchangeHttpFixture>>,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const principal = await authenticateToken(fixture.sql, fixture.ownerToken)
  if (principal === undefined) throw new TypeError("owner authentication failed")
  const rows = await fixture.sql<{ readonly name: string; readonly definition: unknown }[]>`
    select name,definition from saved_views where name in
      ('zero','negated-zero','unbounded','no-project-graph') order by name`
  const service = new HumanQueryService(fixture.sql, fixture.signingKey)
  return Object.fromEntries(
    await Promise.all(
      rows.map(async (row) => {
        const result = await service.queryWorkItems(
          principal,
          "w",
          HumanWorkQuerySchema.parse(row.definition),
        )
        return [row.name, result.items.map((item) => item.title).sort()] as const
      }),
    ),
  )
}
