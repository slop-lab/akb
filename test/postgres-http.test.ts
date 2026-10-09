import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { actorId, eventId, workItemId } from "../src/work-items/identifiers.ts"
import { PostgresWorkItemStore } from "../src/work-items/postgres-store.ts"
import {
  jsonRequest,
  readList,
  readWorkItem,
  startHttpFixtureWithStore,
  VALID_CREATE_BODY,
} from "./http-fixture.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
const sql = database.sql
after(database.close)

test("HTTP routes await the PostgreSQL store through create, patch, get, and list", async (context) => {
  // Given
  const store = new PostgresWorkItemStore(sql, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => new Date().toISOString(),
  })
  const fixture = await startHttpFixtureWithStore(store)
  context.after(fixture.close)

  // When
  const createdResponse = await fixture.request(
    "/api/workspaces/http-workspace/work-items",
    jsonRequest(VALID_CREATE_BODY, "http-create"),
  )
  const created = (await readWorkItem(createdResponse)).item
  const patchedResponse = await fixture.request(`/api/work-items/${created.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: actorId("actor-1"), baseRevision: 1, state: "started" }),
  })
  const readResponse = await fixture.request(`/api/work-items/${created.id}`)
  const listResponse = await fixture.request("/api/workspaces/http-workspace/work-items")

  // Then
  assert.equal(createdResponse.status, 201)
  assert.equal(patchedResponse.status, 200)
  assert.equal((await readWorkItem(readResponse)).item.state, "started")
  assert.deepEqual(
    (await readList(listResponse)).items.map((item) => item.id),
    [created.id],
  )
})
