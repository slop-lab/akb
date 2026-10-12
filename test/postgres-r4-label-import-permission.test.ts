import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { createR4ImportRouter } from "../src/http/human-v1/import-router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { createR4ImportDispatcher } from "../src/import-export/command-dispatcher.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let identity: IdentityAdmin
let server: Server
let endpoint: string
let token: string
let spaceKey: string

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  identity = new IdentityAdmin(fixture.sql)
  const owner = await identity.bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  token = owner.token
  await new SpaceAdmin(fixture.sql).create({
    workspaceId: "w",
    spaceId: "space",
    spaceName: "Space",
    visibility: "public",
  })
  const [space] = await fixture.sql<{ readonly space_key: string }[]>`
    select space_key from space_details where workspace_id='w' and space_id='space'`
  if (space === undefined) throw new TypeError("space key missing")
  spaceKey = space.space_key
  await fixture.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    values ('target-label','w','label','space',1,'owner',clock_timestamp(),clock_timestamp())`
  await fixture.sql`insert into entity_acl_policies values ('target-label','restricted')`
  await fixture.sql`insert into labels (id,workspace_id,space_id,name,color,revision)
    values ('target-label','w','space','Shared label','blue',1)`
  server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-12T00:00:00.000Z",
    },
    [createR4ImportRouter(fixture.sql, Buffer.alloc(32, 11), createR4ImportDispatcher())],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("missing address")
  endpoint = `http://127.0.0.1:${(address satisfies AddressInfo).port}/api/commands/v1/workspaces/w/imports`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  await fixture.close()
})

test("label reuse requires space.read rather than work.read", async () => {
  const permissions = ["project.manage", "space.manage", "space.read", "work.read"] as const
  const allowedToken = await issueImporter("space-importer", permissions)
  const deniedToken = await issueImporter("work-importer", permissions)
  await fixture.sql`insert into entity_acl_allowances (entity_id,principal_id,permission) values
    ('target-label','space-importer','space.read'),('target-label','work-importer','work.read')`
  const allowedId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  token = allowedToken
  assert.equal(
    (await validateAndCommit(body(allowedId), "dddddddd-dddd-4ddd-8ddd-ddddddddddde")).status,
    200,
  )
  assert.equal(await mappedLabel(allowedId), "target-label")

  token = deniedToken
  const deniedId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  const before = await canonicalCounts()
  const denied = await validateAndCommit(body(deniedId), "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef")
  assert.equal(denied.status, 400)
  assert.deepEqual(await denied.json(), { error: { code: "invalid_import" } })
  assert.deepEqual(await canonicalCounts(), before)
})

test("committed label replay requires space.read rather than work.read", async () => {
  const importId = "ffffffff-ffff-4fff-8fff-ffffffffffff"
  const bytes = body(importId)
  await fixture.sql`insert into entity_acl_allowances (entity_id,principal_id,permission)
    values ('target-label','owner','space.read')`
  assert.equal((await validateAndCommit(bytes, "ffffffff-ffff-4fff-8fff-fffffffffffa")).status, 200)
  const allowed = await validateAndCommit(bytes, "ffffffff-ffff-4fff-8fff-fffffffffffb")
  assert.equal(allowed.status, 200, await allowed.clone().text())
  const allowedBody = z.object({ replayed: z.boolean() }).parse(await allowed.json())
  assert.equal(allowedBody.replayed, true)
  await fixture.sql`delete from entity_acl_allowances where entity_id='target-label'`
  await fixture.sql`insert into entity_acl_allowances (entity_id,principal_id,permission)
    values ('target-label','owner','work.read')`
  const before = await canonicalCounts()
  const denied = await validateAndCommit(bytes, "ffffffff-ffff-4fff-8fff-fffffffffffc")
  assert.equal(denied.status, 400)
  assert.deepEqual(await denied.json(), { error: { code: "invalid_import" } })
  assert.deepEqual(await canonicalCounts(), before)
})

async function issueImporter(
  principalId: string,
  permissions: readonly ("project.manage" | "space.manage" | "space.read" | "work.read")[],
): Promise<string> {
  await identity.provisionPrincipal({
    workspaceId: "w",
    principalId,
    displayName: principalId,
    kind: "human",
    role: "member",
    permissions: [...permissions],
  })
  return (
    await identity.issueToken({
      workspaceId: "w",
      principalId,
      expiresAt: "2030-01-01T00:00:00Z",
    })
  ).token
}

function body(importId: string): string {
  return `${[
    { kind: "manifest", version: 1, importId, workspaceId: "w" },
    { kind: "space", externalId: "space", key: spaceKey, name: "Space" },
    { kind: "label", externalId: "label", spaceId: "space", name: "Shared label", color: "blue" },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`
}

async function validateAndCommit(bytes: string, commandId: string): Promise<Response> {
  const validated = await request(bytes, "validate", commandId)
  assert.equal(validated.status, 200)
  const validation = z.object({ validationToken: z.string() }).parse(await validated.json())
  return request(bytes, "commit", commandId, validation.validationToken)
}

function request(
  bytes: string,
  mode: "validate" | "commit",
  commandId: string,
  validationToken?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/x-ndjson",
    "command-id": commandId,
    "idempotency-key": commandId,
  }
  if (validationToken !== undefined) headers["validation-token"] = validationToken
  return fetch(`${endpoint}?mode=${mode}`, { method: "POST", headers, body: bytes })
}

async function mappedLabel(importId: string): Promise<string> {
  const [row] = await fixture.sql<
    { readonly entity_id: string }[]
  >`select entity_id from import_record_ids where import_id=${importId} and record_kind='label'`
  if (row === undefined) throw new TypeError("label mapping missing")
  return row.entity_id
}

async function canonicalCounts() {
  const [counts] = await fixture.sql`select
    (select count(*)::integer from entities) entities,
    (select count(*)::integer from labels) labels,
    (select count(*)::integer from import_batches) batches,
    (select count(*)::integer from import_record_ids) mappings,
    (select count(*)::integer from entity_events_v1) events,
    (select count(*)::integer from entity_outbox_events_v1) outbox`
  return counts
}
