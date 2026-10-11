import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { HumanWorkQuerySchema, type ImportRecord } from "../src/contracts/r4/index.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { IdentityWorkspaceIdSchema, PrincipalIdSchema } from "../src/identity/types.ts"
import {
  createR4ImportDispatcher,
  type R4ImportBatch,
} from "../src/import-export/command-dispatcher.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
})

afterEach(async () => {
  await fixture.close()
})

test("import validation is read-only and commit atomically maps every record family", async () => {
  // Given
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = {
    workspaceId: IdentityWorkspaceIdSchema.parse("w"),
    principalId: PrincipalIdSchema.parse("owner"),
    credentialId: issued.credentialId,
  }
  const importId = "11111111-1111-4111-8111-111111111111"
  const definition = HumanWorkQuerySchema.parse({
    model: "r4",
    filter: null,
    search: null,
    sort: [{ field: "updatedAt", direction: "desc" }],
    includeArchived: false,
    page: { size: 50, cursor: null },
  })
  const records: readonly ImportRecord[] = [
    { kind: "manifest", version: 1, importId, workspaceId: "w" },
    { kind: "space", externalId: "space", key: "IMP", name: "Imported" },
    {
      kind: "workflow_state",
      externalId: "state",
      spaceId: "space",
      name: "Review",
      category: "started",
    },
    {
      kind: "project",
      externalId: "project",
      name: "Imported project",
      slug: "imported-project",
      ownerId: "owner",
    },
    { kind: "label", externalId: "label", spaceId: "space", name: "Imported", color: "blue" },
    {
      kind: "work_item",
      externalId: "work",
      spaceId: "space",
      title: "Imported work",
      ownerId: "owner",
      stateId: "state",
    },
    {
      kind: "relation",
      externalId: "relation",
      fromId: "project",
      toId: "work",
      relationType: "supports",
    },
    {
      kind: "comment",
      externalId: "comment",
      subjectId: "work",
      authorId: "owner",
      body: "Imported note",
    },
    { kind: "saved_view", externalId: "view", ownerId: "owner", name: "Imported view", definition },
  ]
  const batch: R4ImportBatch = { importId, digest: "a".repeat(64), records }
  const dispatcher = createR4ImportDispatcher()

  // When
  await fixture.sql.begin((transaction) =>
    dispatcher.validateCommands(transaction, principal, batch),
  )
  const before = await fixture.sql`select
    (select count(*)::integer from entities) entities,
    (select count(*)::integer from import_batches) batches`
  const first = await fixture.sql.begin((transaction) =>
    dispatcher.importCommands(transaction, principal, batch),
  )
  const replay = await fixture.sql.begin((transaction) =>
    dispatcher.importCommands(transaction, principal, batch),
  )

  // Then
  assert.deepEqual([...before], [{ entities: 0, batches: 0 }])
  assert.deepEqual(first, { replayed: false })
  assert.deepEqual(replay, { replayed: true })
  const after = await fixture.sql`select
    (select count(*)::integer from import_record_ids where import_id=${importId}) mappings,
    (select count(*)::integer from entity_events_v1) events,
    (select count(*)::integer from entity_outbox_events_v1) outbox,
    (select count(*)::integer from search_documents) search,
    (select count(*)::integer from import_batches where import_id=${importId} and state='committed') batches`
  assert.deepEqual([...after], [{ mappings: 8, events: 8, outbox: 8, search: 3, batches: 1 }])
})
