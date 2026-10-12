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
let server: Server
let base: string
let token: string
let targetSpaceKey: string

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  const identity = new IdentityAdmin(fixture.sql)
  await identity.bootstrapWorkspace({
    workspaceId: "foreign",
    workspaceName: "Foreign",
    principalId: "foreign-owner",
    principalName: "Foreign owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const issued = await identity.bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Target",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  token = issued.token
  const spaces = new SpaceAdmin(fixture.sql)
  await spaces.create({
    workspaceId: "foreign",
    spaceId: "shared",
    spaceName: "Foreign shared",
    visibility: "public",
  })
  await spaces.create({
    workspaceId: "w",
    spaceId: "shared",
    spaceName: "Target shared",
    visibility: "public",
  })
  const [space] = await fixture.sql<
    { readonly space_key: string }[]
  >`select space_key from space_details where workspace_id='w' and space_id='shared'`
  if (space === undefined) throw new TypeError("target Space key missing")
  targetSpaceKey = space.space_key
  await seedLabels()
  server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-11T00:00:00.000Z",
    },
    [createR4ImportRouter(fixture.sql, Buffer.alloc(32, 11), createR4ImportDispatcher())],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("server did not listen")
  base = `http://127.0.0.1:${(address satisfies AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  await fixture.close()
})

test("import reuse maps states and labels only from the authorized target workspace", async () => {
  // Given
  const importId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const body = reuseBody(importId, true)

  // When
  const response = await validateAndCommit(body, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab")

  // Then
  assert.equal(response.status, 200)
  const mappings = await fixture.sql`
    select i.record_kind,e.workspace_id,e.id from import_record_ids i
      join entities e on e.id=i.entity_id where i.import_id=${importId} order by i.record_kind`
  assert.deepEqual(
    [...mappings],
    [
      { record_kind: "label", workspace_id: "w", id: "target-label" },
      {
        record_kind: "space",
        workspace_id: "w",
        id: await entityId("w", "space", "shared"),
      },
      {
        record_kind: "workflow_state",
        workspace_id: "w",
        id: await startedStateId("w"),
      },
    ],
  )
})

test("restricted reusable state and label collisions fail closed without canonical writes", async () => {
  // Given
  const targetState = await startedStateId("w")
  await fixture.sql`update entity_acl_policies set mode='restricted'
    where entity_id in (${targetState},'target-label')`
  const before = await canonicalCounts()
  const stateBody = reuseBody("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", false)
  const labelBody = labelOnlyBody("cccccccc-cccc-4ccc-8ccc-cccccccccccc")

  // When
  const stateResponse = await validateAndCommit(stateBody, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc")
  const labelResponse = await validateAndCommit(labelBody, "cccccccc-cccc-4ccc-8ccc-cccccccccccd")

  // Then
  assert.equal(stateResponse.status, 500)
  assert.equal(labelResponse.status, 400)
  assert.deepEqual(await labelResponse.json(), { error: { code: "invalid_import" } })
  const response = await stateResponse.text()
  assert.equal(response.includes(targetState), false)
  assert.equal(response.includes("target-label"), false)
  assert.equal(response.includes("Started"), false)
  assert.equal(response.includes("Shared label"), false)
  assert.deepEqual(await canonicalCounts(), before)
})

async function validateAndCommit(body: string, commandId: string): Promise<Response> {
  const validated = await requestImport(body, "validate", commandId)
  assert.equal(validated.status, 200)
  const response = z.record(z.string(), z.unknown()).parse(await validated.json())
  return requestImport(body, "commit", commandId, z.string().parse(response["validationToken"]))
}

function requestImport(
  body: string,
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
  return fetch(`${base}/api/commands/v1/workspaces/w/imports?mode=${mode}`, {
    method: "POST",
    headers,
    body,
  })
}

function reuseBody(importId: string, includeLabel: boolean): string {
  const records: readonly object[] = [
    manifest(importId),
    importedSpace(),
    {
      kind: "workflow_state",
      externalId: "state",
      spaceId: "space",
      name: "Started",
      category: "started",
      color: "#3B82F6",
      position: 2,
      isDefault: false,
    },
    ...(includeLabel
      ? [
          {
            kind: "label",
            externalId: "label",
            spaceId: "space",
            name: "Shared label",
            color: "blue",
          },
        ]
      : []),
  ]
  return ndjson(records)
}

function labelOnlyBody(importId: string): string {
  return ndjson([
    manifest(importId),
    importedSpace(),
    { kind: "label", externalId: "label", spaceId: "space", name: "Shared label", color: "blue" },
  ])
}

function manifest(importId: string) {
  return { kind: "manifest", version: 1, importId, workspaceId: "w" }
}

function importedSpace() {
  return { kind: "space", externalId: "space", key: targetSpaceKey, name: "Source Space" }
}

function ndjson(records: readonly object[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

async function entityId(workspaceId: string, kind: string, spaceId: string): Promise<string> {
  const [row] = await fixture.sql<
    { readonly id: string }[]
  >`select id from entities where workspace_id=${workspaceId} and kind=${kind}
    and scope_space_id=${spaceId} order by id limit 1`
  if (row === undefined) throw new TypeError(`${kind} entity missing`)
  return row.id
}

async function startedStateId(workspaceId: string): Promise<string> {
  const [row] = await fixture.sql<
    { readonly id: string }[]
  >`select id from workflow_states where workspace_id=${workspaceId}
    and space_id='shared' and category='started' and active`
  if (row === undefined) throw new TypeError("started state missing")
  return row.id
}

async function seedLabels(): Promise<void> {
  await fixture.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at) values
    ('foreign-label','foreign','label','shared',1,'foreign-owner',clock_timestamp(),clock_timestamp()),
    ('target-label','w','label','shared',1,'owner',clock_timestamp(),clock_timestamp())`
  await fixture.sql`insert into entity_acl_policies values
    ('foreign-label','inherit'),('target-label','inherit')`
  await fixture.sql`insert into labels
    (id,workspace_id,space_id,name,color,revision) values
    ('foreign-label','foreign','shared','Shared label','blue',1),
    ('target-label','w','shared','Shared label','blue',1)`
}

async function canonicalCounts() {
  const [counts] = await fixture.sql`select
    (select count(*)::integer from import_batches) batches,
    (select count(*)::integer from import_record_ids) mappings,
    (select count(*)::integer from entity_events_v1) events,
    (select count(*)::integer from entity_outbox_events_v1) outbox`
  return counts
}
