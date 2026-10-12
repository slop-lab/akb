import assert from "node:assert/strict"
import type { Server } from "node:http"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { SearchPageSchema } from "../src/contracts/r4/search.ts"
import { createR4ExportRouter } from "../src/http/human-v1/export-router.ts"
import { createR4SearchRouter } from "../src/http/human-v1/search-router.ts"
import { SnapshotConflictError } from "../src/human-query/service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { createPostgresSearch, searchAuthorized } from "../src/search/postgres-search.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createSearchFixture, type SearchFixture } from "./postgres-r4-search-fixture.ts"

type CommentGraph = {
  readonly hiddenThreadId: string
  readonly visibleCommentId: string
}

let fixture: SearchFixture

beforeEach(async () => {
  fixture = await createSearchFixture()
})

afterEach(async () => fixture.database.close())

test("snapshot and legacy search require comment thread and subject authority", async () => {
  // Given
  const graph = await createCommentGraph()
  const search = createPostgresSearch(fixture.database.sql, fixture.signingKey)
  const request = {
    text: "threadauthority",
    kinds: ["comment"] as const,
    limit: 1,
    cursor: null,
  }
  const first = await search.search(fixture.viewer, "search", request)
  if (first.nextCursor === null) throw new TypeError("fixture continuation missing")
  await restrictThread(graph.hiddenThreadId)

  // When
  const current = await search.search(fixture.viewer, "search", request)
  const legacy = await searchAuthorized(fixture.database.sql, fixture.viewer, {
    text: request.text,
    kinds: request.kinds,
    limit: 10,
  })

  // Then
  await assert.rejects(
    search.search(fixture.viewer, "search", { ...request, cursor: first.nextCursor }),
    SnapshotConflictError,
  )
  assert.equal(current.matched, 1)
  assert.deepEqual(
    current.results.map((result) => result.id),
    [graph.visibleCommentId],
  )
  assert.deepEqual(
    legacy.map((result) => result.id),
    [graph.visibleCommentId],
  )
})

test("authenticated search and export omit a restricted thread while preserving visible comments", async () => {
  // Given
  const graph = await createCommentGraph()
  await restrictThread(graph.hiddenThreadId)
  const admin = new IdentityAdmin(fixture.database.sql)
  await admin.setPermissions({
    workspaceId: "search",
    principalId: "viewer",
    permissions: ["work.read", "project.read", "space.read"],
  })
  const credential = await admin.issueToken({
    workspaceId: "search",
    principalId: "viewer",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const server = createAuthenticatedPostgresServer(
    fixture.database.sql,
    {
      newWorkItemId: () => workItemId("unused-comment-authority"),
      newEventId: () => eventId("unused-comment-authority-event"),
      now: () => "2026-10-12T00:00:00.000Z",
    },
    [
      createR4SearchRouter(fixture.database.sql, fixture.signingKey),
      createR4ExportRouter(fixture.database.sql),
    ],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("HTTP address missing")
  const base = `http://127.0.0.1:${address.port}`

  // When
  const searchResponse = await request(base, credential.token, "/search", {
    text: "threadauthority",
    kinds: ["comment"],
    limit: 10,
  })
  const exportResponse = await request(base, credential.token, "/export", {
    includeArchived: false,
  })
  const page = SearchPageSchema.parse(await searchResponse.json())
  const records = (await exportResponse.text())
    .trimEnd()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
  await close(server)

  // Then
  assert.equal(searchResponse.status, 200)
  assert.equal(page.matched, 1)
  assert.deepEqual(
    page.results.map((result) => result.id),
    [graph.visibleCommentId],
  )
  assert.equal(exportResponse.status, 200)
  assert.deepEqual(
    records
      .filter(
        (record): record is Readonly<Record<string, unknown>> =>
          typeof record === "object" &&
          record !== null &&
          Reflect.get(record, "kind") === "comment",
      )
      .map((record) => Reflect.get(record, "externalId")),
    [graph.visibleCommentId],
  )
})

async function createCommentGraph(): Promise<CommentGraph> {
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
  if (stateId === undefined) throw new TypeError("fixture state missing")
  const hiddenWorkId = await fixture.createWork("public", stateId, "Hidden subject", "hidden")
  const visibleWorkId = await fixture.createWork("public", stateId, "Visible subject", "visible")
  const hiddenCommentId = await fixture.execute("comment.create", hiddenWorkId, null, null, {
    body: "Threadauthority hidden",
  })
  const visibleCommentId = await fixture.execute("comment.create", visibleWorkId, null, null, {
    body: "Threadauthority visible",
  })
  const threads = await fixture.database.sql<{ readonly thread_id: string }[]>`
    select thread_id from comments where id=${hiddenCommentId}`
  const hiddenThreadId = threads[0]?.thread_id
  if (hiddenThreadId === undefined) throw new TypeError("fixture thread missing")
  return { hiddenThreadId, visibleCommentId }
}

async function restrictThread(threadId: string): Promise<void> {
  await fixture.database
    .sql`update entity_acl_policies set mode='restricted' where entity_id=${threadId}`
  await fixture.database.sql`insert into entity_acl_allowances(entity_id,principal_id,permission)
    values (${threadId},'owner','work.read')`
}

function request(base: string, token: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/human/v1/workspaces/search${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}
