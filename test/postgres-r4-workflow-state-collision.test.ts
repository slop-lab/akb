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
import { ndjson } from "./r4-import-export-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let server: Server
let endpoint: string
let token: string

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  token = issued.token
  server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-12T00:00:00.000Z",
    },
    [createR4ImportRouter(fixture.sql, Buffer.alloc(32, 17), createR4ImportDispatcher())],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("server did not listen")
  endpoint = `http://127.0.0.1:${(address satisfies AddressInfo).port}/api/commands/v1/workspaces/w/imports`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  await fixture.close()
})

test("restricted inactive workflow-state collision returns typed denial without writes", async () => {
  // Given
  await new SpaceAdmin(fixture.sql).create({
    workspaceId: "w",
    spaceId: "collision",
    spaceName: "Collision",
    visibility: "public",
  })
  const [space] = await fixture.sql<
    { readonly space_key: string; readonly workflow_id: string }[]
  >`select d.space_key,w.id workflow_id from space_details d join workflows w
    on w.workspace_id=d.workspace_id and w.space_id=d.space_id
    where d.workspace_id='w' and d.space_id='collision'`
  if (space === undefined) throw new TypeError("collision Space missing")
  await fixture.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,lifecycle,current_revision,created_by,created_at,updated_at,
      archived_at)
    values ('inactive-collision','w','workflow_state','collision','archived',1,'owner',
      clock_timestamp(),clock_timestamp(),clock_timestamp())`
  await fixture.sql`insert into entity_acl_policies values ('inactive-collision','restricted')`
  await fixture.sql`insert into workflow_states
    (id,workflow_id,workspace_id,space_id,name,category,color,position,is_default,active,revision)
    values ('inactive-collision',${space.workflow_id},'w','collision','Private retired','started',
      'gray',10,false,false,1)`
  const body = ndjson([
    {
      kind: "manifest",
      version: 1,
      importId: "55555555-5555-4555-8555-555555555555",
      workspaceId: "w",
    },
    { kind: "space", externalId: "space", key: space.space_key, name: "Collision" },
    {
      kind: "workflow_state",
      externalId: "state",
      spaceId: "space",
      name: "Private retired",
      category: "started",
      color: "gray",
      position: 10,
      isDefault: false,
      active: false,
    },
  ])
  const before = await canonicalCounts()

  // When
  const key = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  const validated = await request(body, "validate", key)
  assert.equal(validated.status, 200)
  const validation = z.object({ validationToken: z.string() }).parse(await validated.json())
  const response = await request(body, "commit", key, validation.validationToken)

  // Then
  assert.equal(response.status, 400)
  const responseBody = await response.json()
  assert.deepEqual(responseBody, { error: { code: "invalid_import" } })
  assert.equal(JSON.stringify(responseBody).includes("Private retired"), false)
  assert.equal(JSON.stringify(responseBody).includes("inactive-collision"), false)
  assert.deepEqual(await canonicalCounts(), before)
})

test("inactive workflow-state import does not transiently exceed 20 active states", async () => {
  // Given
  await new SpaceAdmin(fixture.sql).create({
    workspaceId: "w",
    spaceId: "capacity",
    spaceName: "Capacity",
    visibility: "public",
  })
  const [space] = await fixture.sql<
    { readonly space_key: string; readonly workflow_id: string }[]
  >`select d.space_key,w.id workflow_id from space_details d join workflows w
    on w.workspace_id=d.workspace_id and w.space_id=d.space_id
    where d.workspace_id='w' and d.space_id='capacity'`
  if (space === undefined) throw new TypeError("capacity Space missing")
  await fixture.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    select 'capacity-'||position,'w','workflow_state','capacity',1,'owner',clock_timestamp(),
      clock_timestamp() from generate_series(5,19) position`
  await fixture.sql`insert into entity_acl_policies
    select id,'inherit' from entities where id like 'capacity-%'`
  await fixture.sql`insert into workflow_states
    (id,workflow_id,workspace_id,space_id,name,category,color,position,is_default,active,revision)
    select 'capacity-'||position,${space.workflow_id},'w','capacity','State '||position,
      'started','gray',position,false,true,1 from generate_series(5,19) position`
  const importId = "66666666-6666-4666-8666-666666666666"
  const body = ndjson([
    { kind: "manifest", version: 1, importId, workspaceId: "w" },
    { kind: "space", externalId: "space", key: space.space_key, name: "Capacity" },
    {
      kind: "workflow_state",
      externalId: "retired",
      spaceId: "space",
      name: "Retired",
      category: "started",
      color: "gray",
      position: 20,
      isDefault: false,
      active: false,
    },
  ])

  // When
  const key = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  const validated = await request(body, "validate", key)
  assert.equal(validated.status, 200)
  const validation = z.object({ validationToken: z.string() }).parse(await validated.json())
  const response = await request(body, "commit", key, validation.validationToken)

  // Then
  assert.equal(response.status, 200, await response.clone().text())
  const [state] = await fixture.sql<
    { readonly active: boolean; readonly active_count: number; readonly lifecycle: string }[]
  >`select s.active,e.lifecycle,
    (select count(*)::integer from workflow_states where space_id='capacity' and active) active_count
    from import_record_ids i join workflow_states s on s.id=i.entity_id join entities e on e.id=s.id
    where i.import_id=${importId} and i.external_id='retired'`
  assert.deepEqual(state, { active: false, active_count: 20, lifecycle: "archived" })
})

for (const state of [
  { active: false, isDefault: true, position: 10 },
  { active: false, isDefault: false, position: 2_147_483_648 },
]) {
  test(`workflow-state import rejects invalid lifecycle or position ${JSON.stringify(state)}`, async () => {
    const bytes = ndjson([
      {
        kind: "manifest",
        version: 1,
        importId: "88888888-8888-4888-8888-888888888888",
        workspaceId: "w",
      },
      { kind: "space", externalId: "space", key: "INVALID", name: "Invalid fixture" },
      {
        kind: "workflow_state",
        externalId: "state",
        spaceId: "space",
        name: "Invalid state",
        category: "unstarted",
        ...state,
      },
    ])
    const before = await canonicalCounts()

    const response = await request(bytes, "validate", "99999999-9999-4999-8999-999999999999")

    assert.equal(response.status, 400)
    assert.deepEqual(await canonicalCounts(), before)
  })
}

function request(
  bytes: string,
  mode: "validate" | "commit",
  key: string,
  validationToken?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/x-ndjson",
    "command-id": key,
    "idempotency-key": key,
  }
  if (validationToken !== undefined) headers["validation-token"] = validationToken
  return fetch(`${endpoint}?mode=${mode}`, { method: "POST", headers, body: bytes })
}

async function canonicalCounts() {
  const [counts] = await fixture.sql`select
    (select count(*)::integer from entities) entities,
    (select count(*)::integer from workflow_states) states,
    (select count(*)::integer from import_batches) batches,
    (select count(*)::integer from import_record_ids) mappings,
    (select count(*)::integer from entity_events_v1) events,
    (select count(*)::integer from entity_outbox_events_v1) outbox`
  return counts
}
