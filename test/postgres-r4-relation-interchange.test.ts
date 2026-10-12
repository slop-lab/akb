import assert from "node:assert/strict"
import { test } from "node:test"
import { ndjson } from "./r4-import-export-fixture.ts"
import { createInterchangeHttpFixture, validateAndCommit } from "./r4-interchange-http-fixture.ts"

const ARCHIVED_AT = "2026-10-10T12:34:56.789Z"

test("archived former parents and historical cycles never become transiently active", async () => {
  // Given
  const fixture = await createInterchangeHttpFixture()
  try {
    const records = [
      {
        kind: "manifest",
        version: 1,
        importId: "22222222-2222-4222-8222-222222222222",
        workspaceId: "w",
      },
      { kind: "space", externalId: "space", key: "REL", name: "Relations" },
      {
        kind: "workflow_state",
        externalId: "state",
        spaceId: "space",
        name: "Doing",
        category: "started",
        position: 7,
      },
      project("project"),
      work("parent"),
      work("child"),
      work("former"),
      relation("current", "parent", "child", null),
      relation("former-parent", "former", "child", ARCHIVED_AT),
      relation("historical-cycle", "child", "parent", ARCHIVED_AT),
    ]

    // When
    const result = await validateAndCommit(
      fixture.request,
      ndjson(records),
      "33333333-3333-4333-8333-333333333333",
    )

    // Then
    assert.equal(result.validated.status, 200)
    assert.equal(result.commit?.status, 200, await result.commit?.clone().text())
    const rows = await fixture.sql<
      {
        readonly external_id: string
        readonly lifecycle: string
        readonly revision: number
        readonly valid_to: string | null
      }[]
    >`select i.external_id,e.lifecycle,r.revision::integer revision,
      to_char(r.valid_to at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') valid_to
      from import_record_ids i join relations r on r.id=i.entity_id join entities e on e.id=r.id
      where i.import_id='22222222-2222-4222-8222-222222222222' and i.record_kind='relation'
      order by i.external_id`
    assert.deepEqual(
      [...rows],
      [
        { external_id: "current", lifecycle: "active", revision: 1, valid_to: null },
        { external_id: "former-parent", lifecycle: "archived", revision: 2, valid_to: ARCHIVED_AT },
        {
          external_id: "historical-cycle",
          lifecycle: "archived",
          revision: 2,
          valid_to: ARCHIVED_AT,
        },
      ],
    )
    const [events] = await fixture.sql<
      { readonly actors: number; readonly count: number }[]
    >`select count(*)::integer count,count(*) filter (where actor_id='owner')::integer actors
      from entity_events_v1 where subject_kind='relation'`
    assert.deepEqual(events, { actors: 5, count: 5 })
  } finally {
    await fixture.close()
  }
})

function project(externalId: string) {
  return {
    kind: "project",
    externalId,
    name: "Project",
    slug: "project",
    ownerId: "owner",
    participatingSpaceIds: ["space"],
  }
}

function work(externalId: string) {
  return {
    kind: "work_item",
    externalId,
    spaceId: "space",
    title: externalId,
    ownerId: "owner",
    stateId: "state",
    projectId: "project",
  }
}

function relation(externalId: string, fromId: string, toId: string, archivedAt: string | null) {
  return { kind: "relation", externalId, fromId, toId, relationType: "parent_of", archivedAt }
}
