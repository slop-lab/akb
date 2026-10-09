import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import { after, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { EventPageSchema } from "../src/http/event-response-schemas.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
after(database.close)
beforeEach(database.reset)

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

test("authenticated replay pages in sequence and reauthorizes after grant removal", async (context) => {
  // Given
  const admin = new IdentityAdmin(database.sql)
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "replay-workspace",
    workspaceName: "Replay Workspace",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const server = createAuthenticatedPostgresServer(database.sql, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => new Date().toISOString(),
  })
  context.after(() => closeServer(server))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("missing address")
  const base = `http://127.0.0.1:${address.port}`
  const authorization = { authorization: `Bearer ${issued.token}` }
  for (const key of ["one", "two"]) {
    await fetch(`${base}/api/workspaces/replay-workspace/work-items`, {
      method: "POST",
      headers: {
        ...authorization,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({
        title: key,
        accountableOwnerId: "human-one",
        actorId: "human-one",
      }),
    })
  }

  // When
  const firstResponse = await fetch(
    `${base}/api/workspaces/replay-workspace/events?after=0&limit=1`,
    { headers: authorization },
  )
  const first = EventPageSchema.parse(await firstResponse.json())
  const secondResponse = await fetch(
    `${base}/api/workspaces/replay-workspace/events?after=${first.nextAfter}&limit=1`,
    { headers: authorization },
  )
  const second = EventPageSchema.parse(await secondResponse.json())
  await admin.setPermissions({
    workspaceId: "replay-workspace",
    principalId: "human-one",
    permissions: [],
  })
  const denied = await fetch(`${base}/api/workspaces/replay-workspace/events?after=0&limit=1`, {
    headers: authorization,
  })

  // Then
  assert.equal(firstResponse.status, 200)
  assert.deepEqual(
    first.events.map((event) => event.sequence),
    [1],
  )
  assert.equal(first.hasMore, true)
  assert.deepEqual(
    second.events.map((event) => event.sequence),
    [2],
  )
  assert.equal(second.hasMore, false)
  assert.equal(denied.status, 403)
})

test("replay authenticates before strict query validation", async (context) => {
  // Given
  const server = createAuthenticatedPostgresServer(database.sql, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => new Date().toISOString(),
  })
  context.after(() => closeServer(server))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("missing address")

  // When
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/workspaces/%/events?after=01&after=2&limit=0`,
  )

  // Then
  assert.equal(response.status, 401)
})
