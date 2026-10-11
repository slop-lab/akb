import assert from "node:assert/strict"
import { request as rawRequest, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { createR4ImportRouter } from "../src/http/human-v1/import-router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createR4ImportDispatcher } from "../src/import-export/command-dispatcher.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let admin: IdentityAdmin
let server: Server
let base: string
let token: string

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  admin = new IdentityAdmin(fixture.sql)
  const issued = await admin.bootstrapWorkspace({
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
      now: () => "2026-10-11T00:00:00.000Z",
    },
    [createR4ImportRouter(fixture.sql, Buffer.alloc(32, 9), createR4ImportDispatcher())],
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

test("validation rejects duplicate IDs, unknown references, parent cycles, and foreign authors without writes", async () => {
  // Given
  const malicious = [
    [
      manifest("11111111-1111-4111-8111-111111111111"),
      space("same"),
      { ...space("same"), key: "TWO" },
    ],
    [manifest("22222222-2222-4222-8222-222222222222"), work("work", "missing", "missing")],
    [
      manifest("33333333-3333-4333-8333-333333333333"),
      space("space"),
      state(),
      work("a", "space", "state"),
      work("b", "space", "state"),
      relation("r1", "a", "b"),
      relation("r2", "b", "a"),
    ],
    [
      manifest("44444444-4444-4444-8444-444444444444"),
      space("space"),
      state(),
      work("work", "space", "state"),
      {
        kind: "comment",
        externalId: "comment",
        subjectId: "work",
        authorId: "attacker",
        body: "forged",
      },
    ],
  ]

  // When / Then
  for (const records of malicious) {
    const response = await request(ndjson(records), "validate")
    assert.equal(response.status, 400)
  }
  const [counts] = await fixture.sql`select (select count(*)::integer from entities) entities,
    (select count(*)::integer from import_batches) batches,
    (select count(*)::integer from entity_events_v1) events`
  assert.deepEqual(counts, { entities: 0, batches: 0, events: 0 })
})

test("validation rejects bodies above ten MiB and duplicate literal command headers", async () => {
  // Given / When
  const oversized = await request("x".repeat(10 * 1024 * 1024 + 1), "validate")
  const duplicateStatus = await duplicateHeaderRequest(
    ndjson([manifest("55555555-5555-4555-8555-555555555555"), space("space")]),
  )

  // Then
  assert.equal(oversized.status, 400)
  assert.equal(duplicateStatus, 400)
})

test("uncommitted validation tokens fail after authority changes and credential revocation", async () => {
  // Given
  const firstBody = ndjson([manifest("66666666-6666-4666-8666-666666666666"), space("space")])
  const firstValidation = await request(firstBody, "validate")
  const firstToken = await responseToken(firstValidation)
  await fixture.sql`delete from membership_permissions where workspace_id='w' and principal_id='owner'
    and permission='history.read'`

  // When
  const stale = await request(firstBody, "commit", firstToken)
  const secondBody = ndjson([manifest("77777777-7777-4777-8777-777777777777"), space("other")])
  const secondValidation = await request(secondBody, "validate")
  const secondToken = await responseToken(secondValidation)
  const [credential] = await fixture.sql<
    { readonly id: string }[]
  >`select id from principal_credentials
    where workspace_id='w' and principal_id='owner' and revoked_at is null`
  if (credential === undefined) throw new TypeError("credential missing")
  await admin.revokeToken({ credentialId: z.string().uuid().parse(credential.id) })
  const revoked = await request(secondBody, "commit", secondToken)

  // Then
  assert.equal(stale.status, 400)
  assert.equal(revoked.status, 401)
  const [count] = await fixture.sql<
    { readonly count: number }[]
  >`select count(*)::integer count from import_batches`
  assert.equal(count?.count, 0)
})

function request(
  body: string,
  mode: "validate" | "commit",
  validationToken?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/x-ndjson",
    "command-id": "88888888-8888-4888-8888-888888888888",
    "idempotency-key": "security",
  }
  if (validationToken !== undefined) headers["validation-token"] = validationToken
  return fetch(`${base}/api/commands/v1/workspaces/w/imports?mode=${mode}`, {
    method: "POST",
    headers,
    body,
  })
}

async function responseToken(response: Response): Promise<string> {
  assert.equal(response.status, 200)
  const body = z.record(z.string(), z.unknown()).parse(await response.json())
  return stringField(body, "validationToken")
}

function manifest(importId: string) {
  return { kind: "manifest", version: 1, importId, workspaceId: "w" }
}
function space(externalId: string) {
  return {
    kind: "space",
    externalId,
    key: externalId === "other" ? "OTH" : "ONE",
    name: externalId,
  }
}
function state() {
  return {
    kind: "workflow_state",
    externalId: "state",
    spaceId: "space",
    name: "Review",
    category: "started",
  }
}
function work(externalId: string, spaceId: string, stateId: string) {
  return { kind: "work_item", externalId, spaceId, stateId, title: externalId, ownerId: "owner" }
}
function relation(externalId: string, fromId: string, toId: string) {
  return { kind: "relation", externalId, fromId, toId, relationType: "parent_of" }
}
function ndjson(records: readonly object[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

function stringField(value: Readonly<Record<string, unknown>>, name: string): string {
  return z.string().parse(value[name])
}

function duplicateHeaderRequest(body: string): Promise<number | undefined> {
  const url = new URL(`${base}/api/commands/v1/workspaces/w/imports?mode=validate`)
  return new Promise((resolve, reject) => {
    const outgoing = rawRequest(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: [
          "Authorization",
          `Bearer ${token}`,
          "Content-Type",
          "application/x-ndjson",
          "Command-ID",
          "88888888-8888-4888-8888-888888888888",
          "Command-ID",
          "99999999-9999-4999-8999-999999999999",
          "Idempotency-Key",
          "security",
          "Content-Length",
          String(Buffer.byteLength(body)),
        ],
      },
      (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode))
      },
    )
    outgoing.on("error", reject)
    outgoing.end(body)
  })
}
