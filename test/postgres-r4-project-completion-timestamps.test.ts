import assert from "node:assert/strict"
import type { Server } from "node:http"
import { afterEach, beforeEach, test } from "node:test"
import { createR4CommandRouter } from "../src/http/command-v1/router.ts"
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

test("Project completion timestamp follows state transitions through HTTP", async () => {
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "project-completion",
    workspaceName: "Project Completion",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-12T00:00:00.000Z",
    },
    [createR4CommandRouter(fixture.sql)],
  )
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("HTTP address missing")
  const base = `http://127.0.0.1:${address.port}/api/commands/v1/workspaces/project-completion`
  const headers = {
    authorization: `Bearer ${issued.token}`,
    "content-type": "application/json",
  }
  let sequence = 0
  const command = async (path: string, baseRevision: number | null, payload: unknown) => {
    sequence += 1
    const response = await fetch(`${base}${path}`, {
      method: baseRevision === null ? "POST" : "PATCH",
      headers,
      body: JSON.stringify({
        commandId: `command-${sequence}`,
        idempotencyKey: `command-${sequence}`,
        baseRevision,
        payload,
      }),
    })
    assert.equal(response.status, baseRevision === null ? 201 : 200)
    return response
  }

  await command("/spaces", null, {
    id: "engineering",
    key: "ENG",
    name: "Engineering",
    visibility: "public",
    description: "",
    icon: null,
    leadId: "owner",
  })
  const created = await command("/projects", null, {
    name: "Completion lifecycle",
    slug: "completion-lifecycle",
    summary: "",
    ownerId: "owner",
    leadIds: [],
    participatingSpaceIds: ["engineering"],
    state: "active",
    health: "on_track",
    priority: "none",
    startDate: null,
    targetDate: null,
  })
  const projectId = resultId(await created.json())
  assert.equal(await completedAt(projectId), null)

  await command(`/projects/${projectId}`, 1, { state: "completed" })
  const firstCompletion = await completedAt(projectId)
  assert.notEqual(firstCompletion, null)

  await command(`/projects/${projectId}`, 2, {
    name: "Unrelated edit while completed",
    state: "completed",
  })
  assert.equal(await completedAt(projectId), firstCompletion)

  await command(`/projects/${projectId}`, 3, { state: "active" })
  assert.equal(await completedAt(projectId), null)

  await command(`/projects/${projectId}`, 4, { state: "completed" })
  const secondCompletion = await completedAt(projectId)
  assert.notEqual(secondCompletion, null)
  assert.notEqual(secondCompletion, firstCompletion)
})

async function completedAt(projectId: string): Promise<string | null> {
  const rows = await fixture.sql<{ readonly completed_at: string | null }[]>`
    select completed_at::text from projects where id=${projectId}`
  return rows[0]?.completed_at ?? null
}
