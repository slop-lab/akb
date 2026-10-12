import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { ImportRecordSchema } from "../src/contracts/r4/interchange.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import {
  ExportValidationError,
  exportAuthorizedProject,
} from "../src/import-export/export-service.ts"
import { createSearchFixture, type SearchFixture } from "./postgres-r4-search-fixture.ts"

let fixture: SearchFixture
let stateId: string

beforeEach(async () => {
  fixture = await createSearchFixture()
  await new IdentityAdmin(fixture.database.sql).setPermissions({
    workspaceId: "search",
    principalId: "viewer",
    permissions: ["work.read", "space.read", "project.read"],
  })
  await fixture.execute("space.create", null, null, null, {
    id: "public",
    key: "PUB",
    name: "Public",
    visibility: "public",
    description: "",
    icon: null,
    leadId: null,
  })
  const [state] = await fixture.database.sql<{ readonly id: string }[]>`
    select id from workflow_states where workspace_id='search' and space_id='public' and is_default`
  if (state === undefined) throw new TypeError("fixture workflow state missing")
  stateId = state.id
  await fixture.createWork("public", stateId, "Export fixture Work", "export-work")
})

afterEach(async () => fixture.database.close())

for (const reference of ["space", "state"] as const) {
  for (const scoped of [false, true]) {
    test(`Work export requires ${reference} authority with scoped=${scoped}`, async () => {
      await fixture.database.sql`update entity_acl_policies set mode='restricted'
        where entity_id=case when ${reference}='space' then stable_space_entity_id('search','public')
          else ${stateId} end`
      const request = { includeArchived: true, ...(scoped ? { spaceId: "public" } : {}) }

      if (reference === "space" && scoped) {
        await assert.rejects(
          exportAuthorizedProject(fixture.database.sql, fixture.viewer, request),
          (error: unknown) => error instanceof ExportValidationError && error.code === "not_found",
        )
        return
      }
      const output = await exportAuthorizedProject(fixture.database.sql, fixture.viewer, request)
      const records = output
        .trimEnd()
        .split("\n")
        .map((line) => ImportRecordSchema.parse(JSON.parse(line)))

      assert.equal(
        records.some((record) => record.kind === "work_item"),
        false,
      )
      assert.equal(
        records.some((record) => record.kind === "workflow_state" && record.externalId === stateId),
        false,
      )
    })
  }
}

test("authorized Work export retains its complete Space and workflow references", async () => {
  const output = await exportAuthorizedProject(fixture.database.sql, fixture.viewer, {
    includeArchived: true,
    spaceId: "public",
  })
  const records = output
    .trimEnd()
    .split("\n")
    .map((line) => ImportRecordSchema.parse(JSON.parse(line)))

  assert.equal(
    records.some((record) => record.kind === "work_item"),
    true,
  )
  assert.equal(
    records.some((record) => record.kind === "workflow_state" && record.externalId === stateId),
    true,
  )
  assert.equal(
    records.some((record) => record.kind === "space" && record.externalId === "public"),
    true,
  )
})
