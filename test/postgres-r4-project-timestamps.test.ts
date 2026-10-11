import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import type { Server } from "node:http"
import { afterEach, beforeEach, test } from "node:test"
import { ProjectPageSchema, ProjectSchema } from "../src/contracts/r4/index.ts"
import { createR4CommandRouter } from "../src/http/command-v1/router.ts"
import { createR4HumanRouter } from "../src/http/human-v1/human-router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"
import { resultId } from "./r4-command-http-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let server: Server | undefined

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
})

afterEach(async () => {
  if (server?.listening === true) {
    await new Promise<void>((resolve, reject) =>
      server?.close((error?: Error) => (error === undefined ? resolve() : reject(error))),
    )
  }
  await fixture.close()
})

test("Project HTTP reads preserve command timestamps across PostgreSQL timezones", async () => {
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "timestamps",
    workspaceName: "Timestamps",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await fixture.sql`set timezone to 'Asia/Kathmandu'`
  const signingKey = randomBytes(32)
  server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-11T00:00:00.000Z",
    },
    [createR4CommandRouter(fixture.sql), createR4HumanRouter(fixture.sql, signingKey)],
  )
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("HTTP address missing")
  const origin = `http://127.0.0.1:${address.port}`
  const commandBase = `${origin}/api/commands/v1/workspaces/timestamps`
  const humanBase = `${origin}/api/human/v1/workspaces/timestamps`
  const headers = {
    authorization: `Bearer ${issued.token}`,
    "content-type": "application/json",
  }

  await command(
    "/spaces",
    "POST",
    null,
    {
      id: "engineering",
      key: "ENG",
      name: "Engineering",
      visibility: "public",
      description: "",
      icon: null,
      leadId: "owner",
    },
    "create-space",
  )
  const completedId = await createProject("Completed", "completed", "completed")
  const archivedId = await createProject("Archived", "archived", "active")
  await command(`/projects/${archivedId}/archive`, "POST", 1, {}, "archive")
  const stored = await fixture.sql<
    {
      readonly id: string
      readonly completed_ms: string | null
      readonly archived_ms: string | null
      readonly completed_snapshot: string | null
      readonly archived_snapshot: string | null
    }[]
  >`select p.id,floor(extract(epoch from p.completed_at)*1000)::bigint::text completed_ms,
      floor(extract(epoch from p.archived_at)*1000)::bigint::text archived_ms,
      r.canonical_snapshot->>'completed_at' completed_snapshot,
      r.canonical_snapshot->>'archived_at' archived_snapshot
    from projects p join entity_revisions r on r.entity_id=p.id and r.revision=p.revision
    where p.id in (${completedId},${archivedId}) order by p.name`
  const archivedStored = stored.find((row) => row.id === archivedId)
  const completedStored = stored.find((row) => row.id === completedId)
  if (archivedStored === undefined || completedStored === undefined) {
    throw new TypeError("Project timestamps missing")
  }
  assert.match(completedStored.completed_snapshot ?? "", /\+05:45$/)
  assert.match(archivedStored.archived_snapshot ?? "", /\+05:45$/)

  const completedDetailResponse = await fetch(`${humanBase}/projects/${completedId}`, { headers })
  const archivedDetailResponse = await fetch(`${humanBase}/projects/${archivedId}`, { headers })
  assert.equal(completedDetailResponse.status, 200)
  assert.equal(archivedDetailResponse.status, 200)
  const completedDetail = ProjectSchema.parse(await completedDetailResponse.json())
  const archivedDetail = ProjectSchema.parse(await archivedDetailResponse.json())
  assert.equal(completedDetail.completedAt, iso(completedStored.completed_ms))
  assert.equal(archivedDetail.archivedAt, iso(archivedStored.archived_ms))

  const firstResponse = await queryProjects(null)
  assert.equal(firstResponse.status, 200)
  const first = ProjectPageSchema.parse(await firstResponse.json())
  assert.deepEqual(
    first.items.map((project) => [project.name, project.revision, project.completedAt]),
    [["Completed", 1, iso(completedStored.completed_ms)]],
  )
  assert.notEqual(first.nextCursor, null)
  await command(
    `/projects/${archivedId}`,
    "PATCH",
    2,
    { name: "Changed after snapshot" },
    "update-after-snapshot",
  )

  const secondResponse = await queryProjects(first.nextCursor)
  assert.equal(secondResponse.status, 200)
  const second = ProjectPageSchema.parse(await secondResponse.json())
  assert.deepEqual(
    second.items.map((project) => [project.name, project.revision, project.archivedAt]),
    [["Archived", 2, iso(archivedStored.archived_ms)]],
  )

  async function createProject(name: string, slug: string, state: "active" | "completed") {
    const response = await command(
      "/projects",
      "POST",
      null,
      {
        name,
        slug,
        summary: `${name} project`,
        ownerId: "owner",
        leadIds: ["owner"],
        participatingSpaceIds: ["engineering"],
        state,
        health: "on_track",
        priority: "high",
        startDate: null,
        targetDate: null,
      },
      `create-${slug}`,
    )
    return resultId(await response.json())
  }

  async function command(
    path: string,
    method: "POST" | "PATCH",
    baseRevision: number | null,
    payload: unknown,
    key: string,
  ) {
    const response = await fetch(`${commandBase}${path}`, {
      method,
      headers,
      body: JSON.stringify({
        commandId: `command-${key}`,
        idempotencyKey: key,
        baseRevision,
        payload,
      }),
    })
    assert.equal(response.status, baseRevision === null ? 201 : 200)
    return response
  }

  function queryProjects(cursor: string | null) {
    return fetch(`${humanBase}/projects/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        filter: null,
        search: null,
        sort: [{ field: "createdAt", direction: "asc" }],
        includeArchived: true,
        page: { size: 1, cursor },
      }),
    })
  }
})

function iso(epochMilliseconds: string | null): string | null {
  return epochMilliseconds === null ? null : new Date(Number(epochMilliseconds)).toISOString()
}
