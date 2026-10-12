import assert from "node:assert/strict"
import { test } from "node:test"
import type { Sql } from "postgres"
import { ndjson } from "./r4-import-export-fixture.ts"
import { createInterchangeHttpFixture, validateAndCommit } from "./r4-interchange-http-fixture.ts"

const COMPLETED_AT = "2026-10-10T12:34:56.789Z"

test("project completion timestamp with noncompleted state is rejected without writes", async () => {
  await rejectsWithoutWrites([
    ...baseRecords("44444444-4444-4444-8444-444444444444"),
    {
      kind: "project",
      externalId: "project",
      name: "Project",
      slug: "project",
      ownerId: "owner",
      participatingSpaceIds: ["space"],
      state: "active",
      completedAt: COMPLETED_AT,
    },
  ])
})

test("work completion timestamp with noncompleted workflow category is rejected without writes", async () => {
  await rejectsWithoutWrites([
    ...baseRecords("55555555-5555-4555-8555-555555555555"),
    {
      kind: "work_item",
      externalId: "work",
      spaceId: "space",
      title: "Work",
      ownerId: "owner",
      stateId: "state",
      completedAt: COMPLETED_AT,
    },
  ])
})

async function rejectsWithoutWrites(records: readonly Readonly<Record<string, unknown>>[]) {
  // Given
  const fixture = await createInterchangeHttpFixture()
  try {
    const before = await counts(fixture.sql)

    // When
    const result = await validateAndCommit(
      fixture.request,
      ndjson(records),
      "66666666-6666-4666-8666-666666666666",
    )

    // Then
    assert.equal(result.validated.status, 400)
    assert.equal(result.commit, null)
    assert.deepEqual(await result.validated.json(), { error: { code: "invalid_import" } })
    assert.deepEqual(await counts(fixture.sql), before)
  } finally {
    await fixture.close()
  }
}

function baseRecords(importId: string) {
  return [
    { kind: "manifest", version: 1, importId, workspaceId: "w" },
    { kind: "space", externalId: "space", key: "CMP", name: "Completion" },
    {
      kind: "workflow_state",
      externalId: "state",
      spaceId: "space",
      name: "Doing",
      category: "started",
      position: 7,
    },
  ]
}

async function counts(sql: Sql) {
  const [result] = await sql`select
    (select count(*)::integer from entities) entities,
    (select count(*)::integer from import_batches) batches,
    (select count(*)::integer from entity_events_v1) events`
  return result
}
