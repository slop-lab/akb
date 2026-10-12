import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { HumanWorkQuerySchema } from "../src/contracts/r4/query.ts"
import { createR4ExportRouter } from "../src/http/human-v1/export-router.ts"
import { createR4ImportRouter } from "../src/http/human-v1/import-router.ts"
import { HumanQueryService } from "../src/human-query/service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { createR4ImportDispatcher } from "../src/import-export/command-dispatcher.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"
import {
  completeGraph,
  field,
  importRequest,
  ndjson,
  parseObject,
  pick,
} from "./r4-import-export-fixture.ts"

let fixture: UnmigratedPostgresTestFixture

type RoundTripRow = {
  readonly summary: string
  readonly slug: string
  readonly work: unknown
  readonly definition: unknown
  readonly mappings: number
  readonly events: number
}

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
})

afterEach(async () => fixture.close())

test("authorized project export and import preserve the complete R4 graph through HTTP", async () => {
  // Given
  const admin = new IdentityAdmin(fixture.sql)
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const signingKey = Buffer.alloc(32, 7)
  const server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-11T00:00:00.000Z",
    },
    [
      createR4ExportRouter(fixture.sql),
      createR4ImportRouter(fixture.sql, signingKey, createR4ImportDispatcher()),
    ],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("server did not listen")
  const base = `http://127.0.0.1:${(address satisfies AddressInfo).port}`
  const records = completeGraph("11111111-1111-4111-8111-111111111111")
  const bytes = ndjson(records)

  try {
    // When
    const validated = await importRequest(base, issued.token, "validate", bytes)
    assert.equal(validated.response.status, 200, JSON.stringify(validated.body))
    const token = field(validated.body, "validationToken")
    const committed = await importRequest(base, issued.token, "commit", bytes, token)
    assert.equal(committed.response.status, 200, JSON.stringify(committed.body))
    const [mapping] = await fixture.sql<{ readonly entity_id: string }[]>`
      select entity_id from import_record_ids where import_id='11111111-1111-4111-8111-111111111111'
        and external_id='project'`
    if (mapping === undefined) throw new TypeError("project mapping missing")
    await admin.provisionPrincipal({
      workspaceId: "w",
      principalId: "viewer",
      displayName: "Viewer",
      kind: "human",
      role: "member",
      permissions: ["project.read", "space.read", "work.read", "view.read"],
    })
    const viewer = await admin.issueToken({
      workspaceId: "w",
      principalId: "viewer",
      expiresAt: "2030-01-01T00:00:00.000Z",
    })
    const hidden = await fetch(`${base}/api/human/v1/workspaces/w/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${viewer.token}`, "content-type": "application/json" },
      body: JSON.stringify({ includeArchived: true, projectId: mapping.entity_id }),
    })
    assert.equal(hidden.status, 404)
    const exported = await fetch(`${base}/api/human/v1/workspaces/w/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify({ includeArchived: true, projectId: mapping.entity_id }),
    })
    const exportedBytes = await exported.text()
    const exportedRecords = exportedBytes.trimEnd().split("\n").map(parseObject)

    // Then
    assert.equal(exported.status, 200)
    assert.deepEqual(
      exportedRecords.map((record) => field(record, "kind")),
      [
        "manifest",
        "space",
        "workflow_state",
        "workflow_state",
        "workflow_state",
        "workflow_state",
        "workflow_state",
        "workflow_state",
        "project",
        "label",
        "work_item",
        "work_item",
        "relation",
        "comment",
        "saved_view",
      ],
    )
    assert.deepEqual(pick(exportedRecords, "space"), {
      kind: "space",
      externalId: "space",
      key: "IMP",
      name: "Imported",
      visibility: "private",
      description: "Secret roadmap",
      icon: "rocket",
      leadId: "owner",
      workflowStateScope: "all",
    })
    assert.deepEqual(pick(exportedRecords, "project"), {
      kind: "project",
      externalId: mapping.entity_id,
      name: "Imported project",
      slug: "imported-project",
      summary: "Full summary",
      ownerId: "owner",
      leadIds: ["owner"],
      participatingSpaceIds: ["space"],
      state: "active",
      health: "at_risk",
      priority: "high",
      startDate: "2026-10-01",
      targetDate: "2026-10-31",
      completedAt: null,
      archivedAt: null,
    })
    const exportedDefinition = HumanWorkQuerySchema.parse(
      pick(exportedRecords, "saved_view")["definition"],
    )
    assert.equal(exportedDefinition.filter?.op, "and")
    if (exportedDefinition.filter?.op !== "and") throw new TypeError("and filter missing")
    assert.deepEqual(
      exportedDefinition.filter.filters.map((filter) => filter.op),
      ["in", "in", "in"],
    )
    assert.deepEqual(exportedDefinition.filter.filters[0], {
      op: "in",
      field: "spaceId",
      values: ["space"],
    })
    const owner = await authenticateToken(fixture.sql, issued.token)
    if (owner === undefined) throw new TypeError("owner principal missing")
    const sourcePage = await new HumanQueryService(fixture.sql, signingKey).queryWorkItems(
      owner,
      "w",
      exportedDefinition,
    )
    const exportedManifest = exportedRecords[0]
    if (exportedManifest === undefined) throw new TypeError("manifest missing")
    const replayValidation = await importRequest(base, issued.token, "validate", exportedBytes)
    const replayToken = field(replayValidation.body, "validationToken")
    const firstRoundTrip = await importRequest(
      base,
      issued.token,
      "commit",
      exportedBytes,
      replayToken,
    )
    const replay = await importRequest(base, issued.token, "commit", exportedBytes, replayToken)
    assert.equal(firstRoundTrip.response.status, 200, JSON.stringify(firstRoundTrip.body))
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body))
    assert.equal(replay.body["replayed"], true)
    const roundTripImportId = field(exportedManifest, "importId")
    const [roundTrip] = await fixture.sql<RoundTripRow[]>`select
      (select p.summary from import_record_ids i join projects p on p.id=i.entity_id
        where i.import_id=${roundTripImportId} and i.record_kind='project') summary,
      (select p.slug from import_record_ids i join projects p on p.id=i.entity_id
        where i.import_id=${roundTripImportId} and i.record_kind='project') slug,
      (select jsonb_build_object('description',pm.description,'type',pm.item_type,'priority',pm.priority,
        'startDate',pm.start_date::text,'dueDate',pm.due_date::text,'projectId',pm.project_id)
        from import_record_ids i join work_item_pm pm on pm.work_item_id=i.entity_id
        join work_items w on w.id=i.entity_id where i.import_id=${roundTripImportId}
          and i.record_kind='work_item' and w.title='Imported work') work,
      (select v.definition from import_record_ids i join saved_views v on v.id=i.entity_id
        where i.import_id=${roundTripImportId} and i.record_kind='saved_view') definition,
      (select count(*)::integer from import_record_ids where import_id=${roundTripImportId}) mappings,
      (select count(*)::integer from generic_command_idempotency
        where idempotency_key like ${`import:${roundTripImportId}:%`}) events`
    assert.equal(roundTrip?.summary, "Full summary")
    assert.equal(roundTrip?.slug, `imported-project-${roundTripImportId.slice(0, 8)}`)
    assert.deepEqual(roundTrip?.work, {
      description: "Child body",
      type: "Task",
      priority: "medium",
      startDate: "2026-10-03",
      dueDate: "2026-10-18",
      projectId: z.string().parse(await mappedEntity(roundTripImportId, "project")),
    })
    assert.equal(roundTrip?.mappings, 14)
    assert.equal(roundTrip?.events, 6)
    const definition = HumanWorkQuerySchema.parse(roundTrip?.definition)
    assert.equal(definition.filter?.op, "and")
    if (definition.filter?.op !== "and") throw new TypeError("round-trip and filter missing")
    const expectedIds = await Promise.all([
      mappedSpace(roundTripImportId),
      mappedEntity(roundTripImportId, "project"),
      mappedEntity(roundTripImportId, "label"),
    ])
    assert.deepEqual(
      definition.filter.filters.map((filter) => (filter.op === "in" ? filter.values : [])),
      expectedIds.map((id) => [id]),
    )
    const destinationPage = await new HumanQueryService(fixture.sql, signingKey).queryWorkItems(
      owner,
      "w",
      definition,
    )
    assert.deepEqual(
      destinationPage.items.map((item) => item.title).sort(),
      sourcePage.items.map((item) => item.title).sort(),
    )
    const changed = exportedBytes.replace("Full summary", "Changed summary")
    const conflict = await importRequest(base, issued.token, "commit", changed, replayToken)
    assert.equal(conflict.response.status, 409)
    assert.equal(field(exportedManifest, "workspaceId"), "w")
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  }

  async function mappedEntity(importId: string, kind: string): Promise<string> {
    const [row] = await fixture.sql<
      { readonly entity_id: string }[]
    >`select entity_id from import_record_ids
      where import_id=${importId} and record_kind=${kind} order by external_id limit 1`
    if (row === undefined) throw new TypeError(`${kind} mapping missing`)
    return row.entity_id
  }

  async function mappedSpace(importId: string): Promise<string> {
    const [row] = await fixture.sql<{ readonly id: string }[]>`select s.id from import_record_ids i
      join entities e on e.id=i.entity_id join spaces s on s.workspace_id=e.workspace_id
        and stable_space_entity_id(s.workspace_id,s.id)=e.id
      where i.import_id=${importId} and i.record_kind='space' order by i.external_id limit 1`
    if (row === undefined) throw new TypeError("space mapping missing")
    return row.id
  }
})
