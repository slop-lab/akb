import assert from "node:assert/strict"
import type { Server } from "node:http"
import { afterEach, beforeEach, test } from "node:test"
import { SearchPageSchema } from "../src/contracts/r4/search.ts"
import { createR4CommandRouter } from "../src/http/command-v1/router.ts"
import { createR4SearchRouter } from "../src/http/human-v1/search-router.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createSearchFixture, type SearchFixture } from "./postgres-r4-search-fixture.ts"

let fixture: SearchFixture
let server: Server
let origin: string

beforeEach(async () => {
  fixture = await createSearchFixture()
  await fixture.execute("space.create", null, null, null, {
    id: "public",
    key: "PUB",
    name: "Public",
    visibility: "public",
    description: "",
    icon: null,
    leadId: null,
  })
  const states = await fixture.database.sql<{ readonly id: string }[]>`
    select id from workflow_states where workspace_id='search' and space_id='public' and is_default`
  const stateId = states[0]?.id
  if (stateId === undefined) throw new TypeError("fixture default state missing")
  await fixture.createWork("public", stateId, "Frozen phrase Alpha", "alpha")
  await fixture.createWork("public", stateId, "Frozen phrase Zulu", "zulu")
  server = createAuthenticatedPostgresServer(
    fixture.database.sql,
    {
      newWorkItemId: () => workItemId("legacy-unused"),
      newEventId: () => eventId("legacy-event-unused"),
      now: () => "2026-01-01T00:00:00.000Z",
    },
    [
      createR4CommandRouter(fixture.database.sql),
      createR4SearchRouter(fixture.database.sql, fixture.signingKey),
    ],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("HTTP address missing")
  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await close(server)
  await fixture.database.close()
})

test("HTTP search freezes titles while command updates feed the next snapshot", async () => {
  // Given
  const first = await search({ text: "frozen phrase", kinds: ["work_item"], limit: 1 })
  const firstId = first.results[0]?.id
  const rows = await fixture.database.sql<{ readonly id: string }[]>`
    select id from work_items where workspace_id='search' and id<>${firstId ?? ""} limit 1`
  const remainingId = rows[0]?.id
  if (remainingId === undefined || first.nextCursor === null) {
    throw new TypeError("fixture continuation missing")
  }
  const update = await request(
    `/api/commands/v1/workspaces/search/work-items/${encodeURIComponent(remainingId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        commandId: "rename-command",
        idempotencyKey: "rename-command",
        baseRevision: 1,
        payload: { title: "Renamed metadata" },
      }),
    },
  )
  assert.equal(update.status, 200)

  // When
  const continuation = await search({
    text: "frozen phrase",
    kinds: ["work_item"],
    limit: 1,
    cursor: first.nextCursor,
  })
  const current = await search({ text: "renamed metadata", kinds: ["work_item"], limit: 10 })

  // Then
  assert.equal(continuation.results[0]?.sourceRevision, 1)
  assert.match(continuation.results[0]?.title ?? "", /^Frozen phrase/)
  assert.deepEqual(
    current.results.map((result) => [result.id, result.title, result.sourceRevision]),
    [[remainingId, "Renamed metadata", 2]],
  )
})

test("HTTP search rejects unknown request fields and forged cursors", async () => {
  // Given
  const first = await search({ text: "frozen", kinds: ["work_item"], limit: 1 })
  const cursor = first.nextCursor
  if (cursor === null) throw new TypeError("fixture continuation missing")

  // When
  const unknown = await request("/api/human/v1/workspaces/search/search", {
    method: "POST",
    body: JSON.stringify({ text: "frozen", kinds: ["work_item"], limit: 1, extra: true }),
  })
  const forged = await request("/api/human/v1/workspaces/search/search", {
    method: "POST",
    body: JSON.stringify({
      text: "frozen",
      kinds: ["work_item"],
      limit: 1,
      cursor: `x${cursor.slice(1)}`,
    }),
  })

  // Then
  assert.equal(unknown.status, 400)
  assert.equal(forged.status, 400)
})

test("project and comment command edits refresh only new search snapshots", async () => {
  // Given
  const workRows = await fixture.database.sql<{ readonly id: string }[]>`
    select id from work_items where workspace_id='search' order by id limit 1`
  const workId = workRows[0]?.id
  if (workId === undefined) throw new TypeError("fixture Work Item missing")
  const projectCreate = await command(
    "/projects",
    "POST",
    null,
    {
      name: "Oldproject marker",
      slug: "search-project",
      summary: "",
      ownerId: "owner",
      leadIds: [],
      participatingSpaceIds: ["public"],
      state: "active",
      health: "on_track",
      priority: "none",
      startDate: null,
      targetDate: null,
    },
    "project-create",
  )
  const projectId = await resultId(projectCreate)
  const commentCreate = await command(
    `/entities/${encodeURIComponent(workId)}/comments`,
    "POST",
    null,
    { body: "Oldcomment marker" },
    "comment-create",
  )
  const commentId = await resultId(commentCreate)
  const oldProject = await search({ text: "oldproject", kinds: ["project"], limit: 10 })
  const oldComment = await search({ text: "oldcomment", kinds: ["comment"], limit: 10 })
  await command(
    `/projects/${encodeURIComponent(projectId)}`,
    "PATCH",
    1,
    { name: "Newproject marker" },
    "project-update",
  )
  await command(
    `/comments/${encodeURIComponent(commentId)}`,
    "PATCH",
    1,
    { body: "Newcomment marker" },
    "comment-update",
  )

  // When
  const newProject = await search({ text: "newproject", kinds: ["project"], limit: 10 })
  const newComment = await search({ text: "newcomment", kinds: ["comment"], limit: 10 })

  // Then
  assert.equal(oldProject.results[0]?.sourceRevision, 1)
  assert.equal(oldComment.results[0]?.sourceRevision, 1)
  assert.deepEqual(
    newProject.results.map((result) => result.sourceRevision),
    [2],
  )
  assert.deepEqual(
    newComment.results.map((result) => result.sourceRevision),
    [2],
  )
})

async function search(body: unknown) {
  const response = await request("/api/human/v1/workspaces/search/search", {
    method: "POST",
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  return SearchPageSchema.parse(await response.json())
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

function command(
  path: string,
  method: "POST" | "PATCH",
  baseRevision: number | null,
  payload: unknown,
  key: string,
): Promise<Response> {
  return request(`/api/commands/v1/workspaces/search${path}`, {
    method,
    body: JSON.stringify({
      commandId: key,
      idempotencyKey: key,
      baseRevision,
      payload,
    }),
  })
}

async function resultId(response: Response): Promise<string> {
  assert.equal(response.status === 200 || response.status === 201, true)
  const body: unknown = await response.json()
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new TypeError("command result missing")
  }
  const result = body.result
  if (typeof result !== "object" || result === null || !("id" in result)) {
    throw new TypeError("command entity ID missing")
  }
  if (typeof result.id !== "string") throw new TypeError("command entity ID invalid")
  return result.id
}

function close(activeServer: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    activeServer.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}
