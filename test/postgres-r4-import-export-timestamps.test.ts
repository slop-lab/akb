import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import type { Sql } from "postgres"
import { z } from "zod"
import { ImportRecordSchema } from "../src/contracts/r4/index.ts"
import { createR4ExportRouter } from "../src/http/human-v1/export-router.ts"
import { createR4ImportRouter } from "../src/http/human-v1/import-router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createR4ImportDispatcher } from "../src/import-export/command-dispatcher.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createUnmigratedPostgresTestFixture } from "./postgres-fixture.ts"
import {
  completeGraph,
  field,
  importRequest,
  ndjson,
  parseObject,
  pick,
} from "./r4-import-export-fixture.ts"

const SOURCE_IMPORT_ID = "99999999-9999-4999-8999-999999999999"
const SOURCE_TIMESTAMPS = {
  projectCompletedAt: "2026-10-10T18:34:56.123456+05:30",
  projectArchivedAt: "2026-10-10T19:34:56.234567+05:30",
  labelArchivedAt: "2026-10-10T20:34:56.345678+05:30",
  workCompletedAt: "2026-10-10T21:34:56.456789+05:30",
  workArchivedAt: "2026-10-10T22:34:56.567891+05:30",
  relationArchivedAt: "2026-10-10T23:34:56.678912+05:30",
  commentArchivedAt: "2026-10-11T00:34:56.789123+05:30",
  viewArchivedAt: "2026-10-11T01:34:56.891234+05:30",
} as const

test("export canonicalizes database offsets and re-imports completed and archived records", async () => {
  // Given
  const fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const app = await startApp(fixture.sql)

  try {
    const source = ndjson(completeGraph(SOURCE_IMPORT_ID))
    const validated = await importRequest(app.base, issued.token, "validate", source)
    const committed = await importRequest(
      app.base,
      issued.token,
      "commit",
      source,
      field(validated.body, "validationToken"),
    )
    assert.equal(committed.response.status, 200, JSON.stringify(committed.body))
    const ids = await mappedIds(fixture.sql)
    await fixture.sql`update projects set state='completed',
      completed_at=${SOURCE_TIMESTAMPS.projectCompletedAt}::timestamptz,
      archived_at=${SOURCE_TIMESTAMPS.projectArchivedAt}::timestamptz where id=${ids.project}`
    await fixture.sql`update labels set archived_at=${SOURCE_TIMESTAMPS.labelArchivedAt}::timestamptz
      where id=${ids.label}`
    await fixture.sql`update work_item_pm set completed_at=${SOURCE_TIMESTAMPS.workCompletedAt}::timestamptz,
      archived_at=${SOURCE_TIMESTAMPS.workArchivedAt}::timestamptz where work_item_id=${ids.work}`
    await fixture.sql`update relations set valid_to=${SOURCE_TIMESTAMPS.relationArchivedAt}::timestamptz
      where id=${ids.relation}`
    await fixture.sql`update comments set archived_at=${SOURCE_TIMESTAMPS.commentArchivedAt}::timestamptz
      where id=${ids.comment}`
    await fixture.sql`update saved_views set archived_at=${SOURCE_TIMESTAMPS.viewArchivedAt}::timestamptz
      where id=${ids.view}`
    await fixture.sql`update entities set lifecycle='archived',archived_at=clock_timestamp()
      where id=any(${fixture.sql.array([
        ids.project,
        ids.label,
        ids.work,
        ids.relation,
        ids.comment,
        ids.view,
      ])})`

    // When
    const exported = await fetch(`${app.base}/api/human/v1/workspaces/w/export`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify({ includeArchived: true }),
    })
    const exportedBytes = await exported.text()

    // Then
    assert.equal(exported.status, 200, exportedBytes)
    const records = exportedBytes.trimEnd().split("\n").map(parseObject)
    records.forEach((record) => {
      ImportRecordSchema.parse(record)
    })
    assertExportedTimestamps(records)

    const destination = await createUnmigratedPostgresTestFixture()
    try {
      await migrateDatabase(destination.sql)
      const destinationOwner = await new IdentityAdmin(destination.sql).bootstrapWorkspace({
        workspaceId: "w",
        workspaceName: "Restored workspace",
        principalId: "owner",
        principalName: "Owner",
        expiresAt: "2030-01-01T00:00:00.000Z",
      })
      const destinationApp = await startApp(destination.sql)
      try {
        const roundTripValidation = await importRequest(
          destinationApp.base,
          destinationOwner.token,
          "validate",
          exportedBytes,
        )
        assert.equal(
          roundTripValidation.response.status,
          200,
          JSON.stringify(roundTripValidation.body),
        )
        const roundTrip = await importRequest(
          destinationApp.base,
          destinationOwner.token,
          "commit",
          exportedBytes,
          field(roundTripValidation.body, "validationToken"),
        )
        assert.equal(roundTrip.response.status, 200, JSON.stringify(roundTrip.body))

        const restored = await fetch(`${destinationApp.base}/api/human/v1/workspaces/w/export`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${destinationOwner.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ includeArchived: true }),
        })
        const restoredBytes = await restored.text()
        assert.equal(restored.status, 200, restoredBytes)
        const restoredRecords = restoredBytes.trimEnd().split("\n").map(parseObject)
        assertExportedTimestamps(restoredRecords)
      } finally {
        await closeServer(destinationApp.server)
      }
    } finally {
      await destination.close()
    }
  } finally {
    await closeServer(app.server)
    await fixture.close()
  }
})

type TimestampIds = {
  readonly project: string
  readonly label: string
  readonly work: string
  readonly relation: string
  readonly comment: string
  readonly view: string
}

async function mappedIds(sql: Sql): Promise<TimestampIds> {
  const rows = await sql<{ readonly external_id: string; readonly entity_id: string }[]>`
    select external_id,entity_id from import_record_ids where import_id=${SOURCE_IMPORT_ID}`
  return z
    .object({
      project: z.string(),
      label: z.string(),
      work: z.string(),
      relation: z.string(),
      comment: z.string(),
      view: z.string(),
    })
    .parse(Object.fromEntries(rows.map((row) => [row.external_id, row.entity_id])))
}

async function startApp(sql: Sql): Promise<{ readonly server: Server; readonly base: string }> {
  const server = createAuthenticatedPostgresServer(
    sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-11T00:00:00.000Z",
    },
    [
      createR4ExportRouter(sql),
      createR4ImportRouter(sql, Buffer.alloc(32, 5), createR4ImportDispatcher()),
    ],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("server did not listen")
  return { server, base: `http://127.0.0.1:${(address satisfies AddressInfo).port}` }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}

function assertTimestamp(
  record: Readonly<Record<string, unknown>>,
  fieldName: string,
  source: string,
): void {
  const value = z.string().parse(record[fieldName])
  assert.equal(value, new Date(source).toISOString())
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
}

function assertExportedTimestamps(records: readonly Readonly<Record<string, unknown>>[]): void {
  const exportedWork = records.find(
    (record) => record["kind"] === "work_item" && record["title"] === "Imported work",
  )
  if (exportedWork === undefined) throw new TypeError("completed work item missing")
  assert.equal(pick(records, "project")["startDate"], "2026-10-01")
  assertTimestamp(pick(records, "project"), "completedAt", SOURCE_TIMESTAMPS.projectCompletedAt)
  assertTimestamp(pick(records, "project"), "archivedAt", SOURCE_TIMESTAMPS.projectArchivedAt)
  assertTimestamp(exportedWork, "completedAt", SOURCE_TIMESTAMPS.workCompletedAt)
  assertTimestamp(exportedWork, "archivedAt", SOURCE_TIMESTAMPS.workArchivedAt)
  assertTimestamp(pick(records, "label"), "archivedAt", SOURCE_TIMESTAMPS.labelArchivedAt)
  assertTimestamp(pick(records, "relation"), "archivedAt", SOURCE_TIMESTAMPS.relationArchivedAt)
  assertTimestamp(pick(records, "comment"), "archivedAt", SOURCE_TIMESTAMPS.commentArchivedAt)
  assertTimestamp(pick(records, "saved_view"), "archivedAt", SOURCE_TIMESTAMPS.viewArchivedAt)
}
