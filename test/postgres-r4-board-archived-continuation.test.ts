import assert from "node:assert/strict"
import type { Server } from "node:http"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { type BoardRequest, BoardSchema } from "../src/contracts/r4/index.ts"
import { createR4CommandRouter } from "../src/http/command-v1/router.ts"
import { createR4HumanRouter } from "../src/http/human-v1/human-router.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createSearchFixture, type SearchFixture } from "./postgres-r4-search-fixture.ts"

const CommandResultSchema = z
  .object({
    result: z.object({ id: z.string() }).loose(),
    revision: z.number().int().positive(),
  })
  .loose()

let fixture: SearchFixture
let server: Server
let origin: string
let commandSequence: number

beforeEach(async () => {
  fixture = await createSearchFixture()
  commandSequence = 0
  server = createAuthenticatedPostgresServer(
    fixture.database.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-12T00:00:00.000Z",
    },
    [
      createR4CommandRouter(fixture.database.sql),
      createR4HumanRouter(fixture.database.sql, fixture.signingKey),
    ],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("HTTP address missing")
  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  await fixture.database.close()
})

test("board continuation retains a populated column after its state is emptied and archived", async () => {
  // Given
  await command("POST", "/spaces", null, {
    id: "public",
    key: "PUB",
    name: "Public",
    visibility: "public",
    description: "",
    icon: null,
    leadId: null,
  })
  const defaultRows = await fixture.database.sql<{ readonly id: string }[]>`
    select id from workflow_states where workspace_id='search' and space_id='public' and is_default`
  const destinationStateId = required(defaultRows[0]?.id)
  const state = await command("POST", "/spaces/public/workflow/states", null, {
    name: "Frozen review",
    category: "started",
    color: "#2563EB",
    position: 10,
    isDefault: false,
  })
  const workIds = await Promise.all(
    ["Alpha card", "Zulu card"].map(async (title) => {
      const work = await command("POST", "/work-items", null, {
        spaceId: "public",
        title,
        accountableOwnerId: "owner",
        description: "",
        type: "Task",
        workflowStateId: state.id,
        projectId: null,
        priority: "none",
        labelIds: [],
        startDate: null,
        dueDate: null,
      })
      return work.id
    }),
  )
  const initial = await board(null, null)
  assert.equal(initial.status, 200)
  const firstPage = BoardSchema.parse(await initial.json())
  const frozenColumn = required(firstPage.columns.find((column) => column.state.id === state.id))
  const cursor = required(frozenColumn.nextCursor)
  assert.deepEqual(
    frozenColumn.cards.map((card) => card.title),
    ["Alpha card"],
  )

  await Promise.all(
    workIds.map((id) =>
      command("PATCH", `/work-items/${id}`, 1, { workflowStateId: destinationStateId }),
    ),
  )
  const archived = await command(
    "POST",
    `/spaces/public/workflow/states/${state.id}/archive`,
    state.revision,
    {},
  )
  assert.equal(archived.revision, 2)

  // When
  const [continuedResponse, currentResponse] = await Promise.all([
    board(cursor, state.id),
    board(null, null),
  ])

  // Then
  assert.equal(continuedResponse.status, 200)
  assert.equal(currentResponse.status, 200)
  const continued = BoardSchema.parse(await continuedResponse.json())
  const current = BoardSchema.parse(await currentResponse.json())
  assert.equal(continued.columns.length, 1)
  const continuedColumn = required(continued.columns[0])
  assert.deepEqual(continuedColumn.state, frozenColumn.state)
  assert.equal(continuedColumn.total, 2)
  assert.deepEqual(
    continuedColumn.cards.map((card) => card.title),
    ["Zulu card"],
  )
  assert.equal(continuedColumn.nextCursor, null)
  assert.deepEqual(
    [...frozenColumn.cards, ...continuedColumn.cards].map((card) => card.title),
    ["Alpha card", "Zulu card"],
  )
  assert.equal(
    current.columns.some((column) => column.state.id === state.id),
    false,
  )
})

async function command(
  method: "POST" | "PATCH",
  path: string,
  baseRevision: number | null,
  payload: unknown,
): Promise<{ readonly id: string; readonly revision: number }> {
  commandSequence += 1
  const response = await request(`/api/commands/v1/workspaces/search${path}`, {
    method,
    body: JSON.stringify({
      commandId: `board-command-${commandSequence}`,
      idempotencyKey: `board-command-${commandSequence}`,
      baseRevision,
      payload,
    }),
  })
  if (response.status !== 200 && response.status !== 201) {
    assert.fail(await response.text())
  }
  const result = CommandResultSchema.parse(await response.json())
  return { id: result.result.id, revision: result.revision }
}

function board(cursor: string | null, workflowStateId: string | null): Promise<Response> {
  const body = {
    model: "r4",
    filter: { op: "eq", field: "spaceId", value: "public" },
    search: null,
    sort: [{ field: "title", direction: "asc" }],
    includeArchived: false,
    workflowStateId,
    page: { size: 1, cursor },
  } satisfies BoardRequest
  return request("/api/human/v1/workspaces/search/work-items/board", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

function request(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${fixture.ownerToken}`,
      "content-type": "application/json",
    },
  })
}

function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new TypeError("required fixture value missing")
  return value
}
