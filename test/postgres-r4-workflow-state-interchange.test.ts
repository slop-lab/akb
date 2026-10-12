import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { type ImportRecord, ImportRecordSchema } from "../src/contracts/r4/interchange.ts"
import { createR4CommandRouter } from "../src/http/command-v1/router.ts"
import { createR4ExportRouter } from "../src/http/human-v1/export-router.ts"
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
import { ndjson } from "./r4-import-export-fixture.ts"

const TARGET_IMPORT_ID = "33333333-3333-4333-8333-333333333333"
let fixture: UnmigratedPostgresTestFixture
let server: Server
let base: string
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
    [
      createR4CommandRouter(fixture.sql),
      createR4ExportRouter(fixture.sql),
      createR4ImportRouter(fixture.sql, Buffer.alloc(32, 13), createR4ImportDispatcher()),
    ],
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

test("archived workflow states survive HTTP import export replay and re-export", async () => {
  // Given
  const sourceImportId = "11111111-1111-4111-8111-111111111111"
  const source = ndjson([
    { kind: "manifest", version: 1, importId: sourceImportId, workspaceId: "w" },
    { kind: "space", externalId: "source", key: "SRC", name: "Source" },
    {
      kind: "workflow_state",
      externalId: "review",
      spaceId: "source",
      name: "Review",
      category: "started",
      color: "orange",
      position: 7,
      isDefault: false,
    },
  ])
  assert.equal(
    (await validateAndCommit(source, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).commit.status,
    200,
  )
  const sourceStateId = await mappedState(sourceImportId, "review")
  assert.equal(await stateActive(sourceStateId), true)
  const archived = await command(
    `/spaces/source/workflow/states/${sourceStateId}/archive`,
    1,
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  )
  assert.equal(archived.status, 200)
  const sourceRecords = await exportSpace("source")
  const archivedRecord = workflowState(sourceRecords, "Review")
  assert.equal(archivedRecord.active, false)
  const target = ndjson(
    sourceRecords.map((record) => {
      switch (record.kind) {
        case "manifest":
          return { ...record, importId: TARGET_IMPORT_ID }
        case "space":
          return { ...record, externalId: "target", key: "DST", name: "Target" }
        case "workflow_state":
          return { ...record, spaceId: "target" }
        case "project":
        case "label":
        case "work_item":
        case "relation":
        case "comment":
        case "saved_view":
          return record
        default:
          return assertNever(record)
      }
    }),
  )

  // When
  const targetKey = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  const imported = await validateAndCommit(target, targetKey)
  const replay = await importRequest(target, "commit", targetKey, imported.validationToken)
  const reexported = await exportSpace("target")
  const reuse = await validateAndCommit(ndjson(reexported), "77777777-7777-4777-8777-777777777777")

  // Then
  assert.equal(imported.commit.status, 200)
  assert.equal(replay.status, 200)
  assert.equal(reuse.commit.status, 200)
  assert.equal(z.object({ replayed: z.boolean() }).parse(await replay.json()).replayed, true)
  assert.equal(workflowState(reexported, "Review").active, false)
  const targetStateId = await mappedState(TARGET_IMPORT_ID, sourceStateId)
  const reuseManifest = reexported[0]
  if (reuseManifest?.kind !== "manifest") throw new TypeError("re-export manifest missing")
  assert.equal(await mappedState(reuseManifest.importId, targetStateId), targetStateId)
  const [state] = await fixture.sql<
    { readonly active: boolean; readonly lifecycle: string }[]
  >`select s.active,e.lifecycle from workflow_states s join entities e on e.id=s.id
    where s.id=${targetStateId}`
  assert.deepEqual(state, { active: false, lifecycle: "archived" })
  const [evidence] = await fixture.sql<
    { readonly active_states: number; readonly archive_commands: number }[]
  >`select
    (select count(*)::integer from workflow_states where space_id='target' and active) active_states,
    (select count(*)::integer from generic_command_idempotency where workspace_id='w'
      and idempotency_key=${`import:${TARGET_IMPORT_ID}:${sourceStateId}:archive`}
      and action='workflow-state.archive') archive_commands`
  assert.deepEqual(evidence, { active_states: 5, archive_commands: 1 })
})

async function validateAndCommit(bytes: string, key: string) {
  const validated = await importRequest(bytes, "validate", key)
  assert.equal(validated.status, 200)
  const validation = z.object({ validationToken: z.string() }).parse(await validated.json())
  const commit = await importRequest(bytes, "commit", key, validation.validationToken)
  return { commit, validationToken: validation.validationToken }
}

function importRequest(
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
  return fetch(`${base}/api/commands/v1/workspaces/w/imports?mode=${mode}`, {
    method: "POST",
    headers,
    body: bytes,
  })
}

function command(path: string, baseRevision: number, key: string): Promise<Response> {
  return fetch(`${base}/api/commands/v1/workspaces/w${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ commandId: key, idempotencyKey: key, baseRevision, payload: {} }),
  })
}

async function exportSpace(spaceId: string) {
  const response = await fetch(`${base}/api/human/v1/workspaces/w/export`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ includeArchived: true, spaceId }),
  })
  assert.equal(response.status, 200)
  return (await response.text())
    .trimEnd()
    .split("\n")
    .map((line) => ImportRecordSchema.parse(JSON.parse(line)))
}

function workflowState(records: readonly ImportRecord[], name: string) {
  const state = records.find((record) => record.kind === "workflow_state" && record.name === name)
  if (state === undefined) throw new TypeError("workflow state missing")
  if (state.kind !== "workflow_state") throw new TypeError("workflow state kind mismatch")
  return state
}

async function mappedState(importId: string, externalId: string): Promise<string> {
  const [row] = await fixture.sql<
    { readonly entity_id: string }[]
  >`select entity_id from import_record_ids where import_id=${importId}
    and external_id=${externalId} and record_kind='workflow_state'`
  if (row === undefined) throw new TypeError("workflow state mapping missing")
  return row.entity_id
}

async function stateActive(id: string): Promise<boolean> {
  const [state] = await fixture.sql<{ readonly active: boolean }[]>`
    select active from workflow_states where id=${id}`
  if (state === undefined) throw new TypeError("workflow state missing")
  return state.active
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected record: ${JSON.stringify(value)}`)
}
