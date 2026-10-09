import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
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
beforeEach(database.reset)

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

test("authenticated PostgreSQL HTTP denies before validation and revalidates revocation", async (context) => {
  const admin = new IdentityAdmin(sql)
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "http-workspace",
    workspaceName: "HTTP Workspace",
    principalId: "human-1",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const server = createAuthenticatedPostgresServer(sql, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => "2026-10-09T12:00:00.000Z",
  })
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("missing address")
  const request = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, init)

  const missing = await request("/api/workspaces/%/work-items")
  const malformed = await request("/api/workspaces/http-workspace/work-items", {
    headers: { authorization: "Bearer invalid" },
  })
  const created = await request("/api/workspaces/http-workspace/work-items", {
    method: "POST",
    headers: {
      authorization: `Bearer ${issued.token}`,
      "content-type": "application/json",
      "idempotency-key": "http-authorized",
    },
    body: JSON.stringify({
      title: "Authorized",
      accountableOwnerId: "human-1",
      actorId: "human-1",
    }),
  })
  const crossWorkspace = await request("/api/workspaces/other/work-items", {
    headers: { authorization: `Bearer ${issued.token}` },
  })
  await admin.revokeToken({ credentialId: issued.credentialId })
  const revoked = await request("/api/workspaces/http-workspace/work-items", {
    headers: { authorization: `Bearer ${issued.token}` },
  })

  assert.equal(missing.status, 401)
  assert.equal(malformed.status, 401)
  assert.equal(created.status, 201)
  assert.equal(crossWorkspace.status, 404)
  assert.equal(revoked.status, 401)
  assert.equal(missing.headers.get("www-authenticate"), "Bearer")
  assert.deepEqual(await missing.json(), await revoked.json())
})

test("authenticated PostgreSQL HTTP rejects forged actor and grant removal without mutation", async (context) => {
  const admin = new IdentityAdmin(sql)
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "http-workspace",
    workspaceName: "HTTP Workspace",
    principalId: "human-1",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const server = createAuthenticatedPostgresServer(sql, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => "2026-10-09T12:00:00.000Z",
  })
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("missing address")
  const url = `http://127.0.0.1:${address.port}/api/workspaces/http-workspace/work-items`
  const forged = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${issued.token}`,
      "content-type": "application/json",
      "idempotency-key": "forged",
    },
    body: JSON.stringify({ title: "Forged", accountableOwnerId: "human-1", actorId: "other" }),
  })
  await admin.setPermissions({
    workspaceId: "http-workspace",
    principalId: "human-1",
    permissions: [],
  })
  const denied = await fetch(url, { headers: { authorization: `Bearer ${issued.token}` } })
  const counts = await sql<
    { readonly count: number }[]
  >`select count(*)::integer as count from work_items`

  assert.equal(forged.status, 403)
  assert.equal(denied.status, 403)
  assert.equal(counts[0]?.count, 0)
})
