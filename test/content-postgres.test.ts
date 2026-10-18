import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { after, before, test } from "node:test"
import { z } from "zod"
import { createContentRoutes } from "../src/http/content/index.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let server: Server | undefined
let base: string
let token: string

before(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "content-workspace",
    workspaceName: "Content",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  token = issued.token
  await fixture.sql`insert into membership_permissions (workspace_id,principal_id,permission)
    values ('content-workspace','owner','content.read'),
      ('content-workspace','owner','content.manage')`
  await fixture.sql`insert into entity_outbox_destinations_v1
    (workspace_id,destination_id,sink,start_after_sequence)
    values ('content-workspace','content-test','database-inbox',0)`
  const runningServer = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-17T00:00:00.000Z",
    },
    createContentRoutes(fixture.sql),
  )
  server = runningServer
  await new Promise<void>((resolve) => runningServer.listen(0, "127.0.0.1", resolve))
  const address = runningServer.address()
  if (address === null || typeof address === "string") throw new TypeError("server did not listen")
  base = `http://127.0.0.1:${(address satisfies AddressInfo).port}`
})

after(async () => {
  if (server !== undefined) {
    const runningServer = server
    await new Promise<void>((resolve, reject) =>
      runningServer.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  }
  await fixture.close()
})

test("authenticated content HTTP completes nested revision collaboration and transfer workflow", async () => {
  // Given
  const anonymous = await fetch(
    `${base}/api/content/v1/workspaces/content-workspace/pages/page-parent`,
  )
  assert.equal(anonymous.status, 401)
  const firstDocument = {
    version: 1,
    blocks: [{ id: "intro", type: "paragraph", text: "First", children: [] }],
  }
  const parent = await command("/pages", "POST", null, {
    pageId: "page-parent",
    title: "Parent",
    document: firstDocument,
  })
  assert.equal(parent.status, 201, await parent.text())
  const child = await command("/pages", "POST", null, {
    pageId: "page-child",
    parentPageId: "page-parent",
    title: "Child",
    document: firstDocument,
  })
  assert.equal(child.status, 201, await child.text())

  // When
  const patched = await command("/pages/page-parent", "PATCH", 1, {
    title: "Parent updated",
    document: {
      version: 1,
      blocks: [
        { id: "intro", type: "paragraph", text: "Second", children: [] },
        {
          id: "child-link",
          type: "entity_embed",
          text: "Child",
          entityId: "page-child",
          children: [],
        },
      ],
    },
  })

  // Then
  assert.equal(patched.status, 200)
  assert.equal((await command("/pages/page-parent", "PATCH", 1, { title: "Stale" })).status, 409)
  assert.equal((await get("/pages?parentPageId=page-parent")).status, 200)
  assert.equal((await get("/pages/page-parent/history")).status, 200)
  const backlink = z
    .object({ backlinks: z.array(z.unknown()) })
    .parse(await (await get("/pages/page-child/backlinks")).json())
  assert.equal(backlink.backlinks.length, 1)
  const exported = await get("/pages/page-parent/export")
  assert.equal(exported.status, 200)
  const markdown = await exported.text()
  assert.match(markdown, /:::afw-block/)
  const imported = await command("/pages/import", "POST", null, {
    pageId: "page-imported",
    title: "Imported",
    markdown,
  })
  assert.equal(imported.status, 201)
  const importedPage = z
    .object({
      page: z.object({
        document: z.object({
          blocks: z.array(z.object({ entityId: z.string().optional() })),
        }),
      }),
    })
    .parse(await (await get("/pages/page-imported")).json())
  assert.equal(importedPage.page.document.blocks[1]?.entityId, "page-child")
  assert.equal(
    (await command("/pages/page-parent", "PATCH", 2, { parentPageId: "page-child" })).status,
    409,
  )
  assert.equal(
    (await command("/pages/page-parent/restore", "POST", 2, { revision: 1 })).status,
    200,
  )
  assert.equal(
    (
      await command("/pages/page-parent/comments", "POST", null, {
        commentId: "comment-one",
        blockId: "intro",
        body: "Review this",
      })
    ).status,
    201,
  )
  assert.equal((await get("/pages/page-parent/comments")).status, 200)
  assert.equal(
    (
      await request("/pages/page-parent/presence", {
        method: "PUT",
        body: JSON.stringify({ blockId: "intro", cursor: 2 }),
      })
    ).status,
    204,
  )
  const presence = z
    .object({ presence: z.array(z.unknown()) })
    .parse(await (await get("/pages/page-parent/presence")).json())
  assert.equal(presence.presence.length, 1)
  assert.equal((await command("/pages/page-child/archive", "POST", 1, {})).status, 200)
  const replayCommandId = randomUUID()
  const replayBody = JSON.stringify({
    commandId: replayCommandId,
    idempotencyKey: `content-replay-${replayCommandId}`,
    baseRevision: null,
    payload: { pageId: "page-replay", title: "Replay", document: firstDocument },
  })
  assert.equal((await request("/pages", { method: "POST", body: replayBody })).status, 201)
  assert.equal((await request("/pages", { method: "POST", body: replayBody })).status, 200)
  const counts = await fixture.sql`select
    (select count(*)::integer from entity_revisions where entity_id in
      ('page-parent','page-child','page-imported','comment-one')) revisions,
    (select count(*)::integer from entity_events_v1 where subject_id in
      ('page-parent','page-child','page-imported','comment-one')) events,
    (select count(*)::integer from entity_outbox_jobs_v1 where destination_id='content-test') jobs`
  assert.deepEqual([...counts], [{ revisions: 7, events: 7, jobs: 8 }])
  const replayCounts = await fixture.sql`select
    (select count(*)::integer from entity_revisions where entity_id='page-replay') revisions,
    (select count(*)::integer from entity_events_v1 where subject_id='page-replay') events`
  assert.deepEqual([...replayCounts], [{ revisions: 1, events: 1 }])
})

test("private Space page creation and import require scoped content management", async () => {
  const identity = new IdentityAdmin(fixture.sql)
  await identity.provisionPrincipal({
    workspaceId: "content-workspace",
    principalId: "content-member",
    displayName: "Content member",
    kind: "human",
    role: "member",
    permissions: ["content.manage"],
  })
  const member = await identity.issueToken({
    workspaceId: "content-workspace",
    principalId: "content-member",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const spaces = new SpaceAdmin(fixture.sql)
  await spaces.create({
    workspaceId: "content-workspace",
    spaceId: "private-content",
    spaceName: "Private content",
    visibility: "private",
  })

  const deniedCreate = await command(
    "/pages",
    "POST",
    null,
    {
      pageId: "private-create-denied",
      spaceId: "private-content",
      title: "Denied create",
      document: { version: 1, blocks: [] },
    },
    member.token,
  )
  const deniedImport = await command(
    "/pages/import",
    "POST",
    null,
    {
      pageId: "private-import-denied",
      spaceId: "private-content",
      title: "Denied import",
      markdown: ':::afw-block {"id":"private","type":"paragraph"}\nPrivate\n:::\n',
    },
    member.token,
  )
  const missingSpace = await command(
    "/pages",
    "POST",
    null,
    {
      pageId: "missing-space-denied",
      spaceId: "missing-content",
      title: "Missing Space",
      document: { version: 1, blocks: [] },
    },
    member.token,
  )

  assert.equal(deniedCreate.status, 404)
  const notFound = {
    error: { code: "not_found", message: "entity was not found", retryable: false, details: {} },
  }
  assert.deepEqual(await deniedCreate.json(), notFound)
  assert.equal(deniedImport.status, 404)
  assert.deepEqual(await deniedImport.json(), notFound)
  assert.equal(missingSpace.status, 404)
  assert.deepEqual(await missingSpace.json(), notFound)
  const deniedRows = await fixture.sql`select id from entities where id in
    ('private-create-denied','private-import-denied','missing-space-denied')`
  assert.equal(deniedRows.length, 0)

  await spaces.setPermissions({
    workspaceId: "content-workspace",
    spaceId: "private-content",
    principalId: "content-member",
    permissions: ["content.manage"],
  })
  const allowedCreate = await command(
    "/pages",
    "POST",
    null,
    {
      pageId: "private-create-allowed",
      spaceId: "private-content",
      title: "Allowed create",
      document: { version: 1, blocks: [] },
    },
    member.token,
  )
  const allowedImport = await command(
    "/pages/import",
    "POST",
    null,
    {
      pageId: "private-import-allowed",
      spaceId: "private-content",
      title: "Allowed import",
      markdown: ':::afw-block {"id":"private","type":"paragraph"}\nPrivate\n:::\n',
    },
    member.token,
  )

  assert.equal(allowedCreate.status, 201, await allowedCreate.text())
  assert.equal(allowedImport.status, 201, await allowedImport.text())
})

async function command(
  path: string,
  method: "POST" | "PATCH",
  baseRevision: number | null,
  payload: Readonly<Record<string, unknown>>,
  authToken = token,
): Promise<Response> {
  const commandId = randomUUID()
  return request(
    path,
    {
      method,
      body: JSON.stringify({
        commandId,
        idempotencyKey: `content-${commandId}`,
        baseRevision,
        payload,
      }),
    },
    authToken,
  )
}

function get(path: string): Promise<Response> {
  return request(path, { method: "GET" })
}

function request(path: string, init: RequestInit, authToken = token): Promise<Response> {
  return fetch(`${base}/api/content/v1/workspaces/content-workspace${path}`, {
    ...init,
    headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
  })
}
