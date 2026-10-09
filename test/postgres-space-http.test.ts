import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import { after, beforeEach, test } from "node:test"
import { EventPageSchema } from "../src/http/event-response-schemas.ts"
import {
  WorkItemEnvelopeSchema,
  WorkItemListSchema,
} from "../src/http/work-item-response-schemas.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"
import { readErrorCode } from "./http-fixture.ts"

const database = await createPostgresTestFixture()
const identity = new IdentityAdmin(database.sql)
const spaces = new SpaceAdmin(database.sql)
after(database.close)
beforeEach(database.reset)

test("scoped HTTP create, patch, list, events, replay, history, and outbox preserve Space scope", async (context) => {
  const issued = await identity.bootstrapWorkspace({
    workspaceId: "workspace",
    workspaceName: "Workspace",
    principalId: "actor",
    principalName: "Actor",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await spaces.create({
    workspaceId: "workspace",
    spaceId: "private",
    spaceName: "Private",
    visibility: "private",
  })
  await spaces.setPermissions({
    workspaceId: "workspace",
    spaceId: "private",
    principalId: "actor",
    permissions: ["work.read", "work.create", "work.update", "work.assign"],
  })
  const api = await startServer(context)
  const createdResponse = await api.request("/api/workspaces/workspace/work-items", issued.token, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "scoped" },
    body: JSON.stringify({
      title: "Scoped",
      accountableOwnerId: "actor",
      actorId: "actor",
      spaceId: "private",
    }),
  })
  const created = WorkItemEnvelopeSchema.parse(await createdResponse.json()).item

  const rejectedPatch = await api.request(`/api/work-items/${created.id}`, issued.token, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: "actor", baseRevision: 1, state: "started", spaceId: "other" }),
  })
  const readAfterRejected = WorkItemEnvelopeSchema.parse(
    await (await api.request(`/api/work-items/${created.id}`, issued.token)).json(),
  ).item
  const patched = WorkItemEnvelopeSchema.parse(
    await (
      await api.request(`/api/work-items/${created.id}`, issued.token, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actorId: "actor", baseRevision: 1, state: "started" }),
      })
    ).json(),
  ).item
  const listed = WorkItemListSchema.parse(
    await (await api.request("/api/workspaces/workspace/work-items", issued.token)).json(),
  )
  const events = EventPageSchema.parse(
    await (
      await api.request("/api/workspaces/workspace/events?after=0&limit=100", issued.token)
    ).json(),
  )
  const replayed = WorkItemEnvelopeSchema.parse(
    await (
      await api.request("/api/workspaces/workspace/work-items", issued.token, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "scoped" },
        body: JSON.stringify({
          title: "Scoped",
          accountableOwnerId: "actor",
          actorId: "actor",
          spaceId: "private",
        }),
      })
    ).json(),
  ).item
  const projections = await database.sql<{ readonly space_id: string | null }[]>`
    select space_id from work_item_revisions union all select space_id from outbox_events`

  assert.equal(createdResponse.status, 201)
  assert.equal(rejectedPatch.status, 400)
  assert.equal(readAfterRejected.revision, 1)
  assert.equal(patched.spaceId, "private")
  assert.equal(listed.items[0]?.spaceId, "private")
  assert.deepEqual(
    events.events.map((event) => event.spaceId),
    ["private", "private"],
  )
  assert.equal(replayed.revision, 1)
  assert.deepEqual(
    projections.map((row) => row.space_id),
    ["private", "private", "private", "private"],
  )
})

test("private exact HTTP routes hide existing items and distinct owners require Space read", async (context) => {
  const issued = await identity.bootstrapWorkspace({
    workspaceId: "workspace",
    workspaceName: "Workspace",
    principalId: "actor",
    principalName: "Actor",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await identity.provisionPrincipal({
    workspaceId: "workspace",
    principalId: "owner",
    displayName: "Owner",
    kind: "human",
    role: "member",
    permissions: ["work.read"],
  })
  await identity.provisionPrincipal({
    workspaceId: "workspace",
    principalId: "viewer",
    displayName: "Viewer",
    kind: "human",
    role: "member",
    permissions: ["work.read", "work.update"],
  })
  const viewer = await identity.issueToken({
    workspaceId: "workspace",
    principalId: "viewer",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await spaces.create({
    workspaceId: "workspace",
    spaceId: "private",
    spaceName: "Private",
    visibility: "private",
  })
  await spaces.setPermissions({
    workspaceId: "workspace",
    spaceId: "private",
    principalId: "actor",
    permissions: ["work.create", "work.assign"],
  })
  const api = await startServer(context)
  const create = () =>
    api.request("/api/workspaces/workspace/work-items", issued.token, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "owner-boundary" },
      body: JSON.stringify({
        title: "Private",
        accountableOwnerId: "owner",
        actorId: "actor",
        spaceId: "private",
      }),
    })

  const deniedOwner = await create()
  await spaces.setPermissions({
    workspaceId: "workspace",
    spaceId: "private",
    principalId: "owner",
    permissions: ["work.read"],
  })
  const createdResponse = await create()
  const created = WorkItemEnvelopeSchema.parse(await createdResponse.json()).item
  const hiddenGet = await api.request(`/api/work-items/${created.id}`, viewer.token)
  const absentGet = await api.request("/api/work-items/absent", viewer.token)
  const hiddenPatch = await patch(api, created.id, viewer.token)
  const absentPatch = await patch(api, "absent", viewer.token)

  assert.equal(deniedOwner.status, 403)
  assert.equal(createdResponse.status, 201)
  assert.equal(hiddenGet.status, 404)
  assert.equal(await readErrorCode(hiddenGet), await readErrorCode(absentGet))
  assert.equal(hiddenPatch.status, 404)
  assert.equal(await readErrorCode(hiddenPatch), await readErrorCode(absentPatch))
})

async function startServer(context: { after(callback: () => Promise<void>): void }) {
  const server = createAuthenticatedPostgresServer(database.sql, {
    newWorkItemId: () => workItemId(randomUUID()),
    newEventId: () => eventId(randomUUID()),
    now: () => "2026-10-09T12:00:00.000Z",
  })
  context.after(() => closeServer(server))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("missing server address")
  return {
    request: (path: string, token: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
      }),
  }
}

function patch(
  api: { readonly request: (path: string, token: string, init?: RequestInit) => Promise<Response> },
  id: string,
  token: string,
): Promise<Response> {
  return api.request(`/api/work-items/${id}`, token, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: "viewer", baseRevision: 1, state: "started" }),
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}
