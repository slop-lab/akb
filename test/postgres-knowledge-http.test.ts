import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { z } from "zod"
import { createKnowledgeRoutes } from "../src/http/knowledge/index.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { ALL_WORK_PERMISSIONS } from "../src/identity/types.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"
import { sendRawRequest } from "./raw-http-fixture.ts"

const CommandResultSchema = z.object({
  result: z.strictObject({
    proposalId: z.string(),
    targetId: z.string(),
    reviewId: z.string().optional(),
  }),
})
let fixture: UnmigratedPostgresTestFixture
let port: number
let token: string
let sequence = 0
let server: ReturnType<typeof createAuthenticatedPostgresServer>

before(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  const admin = new IdentityAdmin(fixture.sql)
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "workspace",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await admin.setPermissions({
    workspaceId: "workspace",
    principalId: "owner",
    permissions: [...ALL_WORK_PERMISSIONS],
  })
  token = issued.token
  server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId(`unused-${++sequence}`),
      newEventId: () => eventId(`unused-${++sequence}`),
      now: () => "2026-10-17T00:00:00.000Z",
    },
    createKnowledgeRoutes(fixture.sql),
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new TypeError("server address unavailable")
  port = address.port
})

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  await fixture.close()
})

test("authenticated HTTP promotes a proposal and exposes accepted search plus superseded history", async () => {
  // Given
  const unauthorized = await sendRawRequest({
    port,
    method: "GET",
    path: "/api/knowledge/v1/workspaces/workspace/objects",
  })
  assert.equal(unauthorized.status, 401)
  const created = await command("/proposals", null, {
    targetId: "http-knowledge",
    action: "knowledge.create",
    baseRevision: null,
    candidate: claim("Canonical HTTP knowledge", "accepted"),
    sources: [],
    relations: [],
    profileId: null,
    profileRevision: null,
    inputRevision: null,
  })

  // When
  const accepted = await command(`/proposals/${created.result.proposalId}/reviews`, 1, {
    decision: "accepted",
    rationale: "approved",
    policyId: "human-review",
    policyRevision: 1,
  })

  // Then
  assert.equal(accepted.result.targetId, "http-knowledge")
  const detail = await get("/objects/http-knowledge")
  assert.equal(detail.status, 200)
  assert.equal(
    z
      .object({ revision: z.number(), candidate: z.object({ statement: z.string() }) })
      .parse(JSON.parse(detail.body)).candidate.statement,
    "Canonical HTTP knowledge",
  )
  const search = await get("/objects?query=Canonical")
  assert.equal(z.array(z.unknown()).parse(JSON.parse(search.body)).length, 1)

  const supersede = await command("/proposals", null, {
    targetId: "http-knowledge",
    action: "knowledge.revise",
    baseRevision: 1,
    candidate: claim("Canonical HTTP knowledge", "superseded"),
    sources: [],
    relations: [],
    profileId: null,
    profileRevision: null,
    inputRevision: null,
  })
  await command(`/proposals/${supersede.result.proposalId}/reviews`, 1, {
    decision: "accepted",
    rationale: "superseded",
    policyId: "human-review",
    policyRevision: 1,
  })
  const defaultList = await get("/objects")
  const completeList = await get("/objects?includeSuperseded=true")
  const history = await get("/objects/http-knowledge/history")
  assert.equal(z.array(z.unknown()).parse(JSON.parse(defaultList.body)).length, 0)
  assert.equal(z.array(z.unknown()).parse(JSON.parse(completeList.body)).length, 1)
  assert.deepEqual(
    z
      .array(z.object({ revision: z.number() }))
      .parse(JSON.parse(history.body))
      .map((entry) => entry.revision),
    [2, 1],
  )
})

test("authenticated HTTP rejects a client-selected review policy without mutations", async () => {
  // Given
  const created = await command("/proposals", null, {
    targetId: "http-policy-target",
    action: "knowledge.create",
    baseRevision: null,
    candidate: claim("Policy protected HTTP knowledge", "accepted"),
    sources: [],
    relations: [],
    profileId: null,
    profileRevision: null,
    inputRevision: null,
  })

  // When
  const response = await rawCommand(`/proposals/${created.result.proposalId}/reviews`, 1, {
    decision: "accepted",
    rationale: "client override",
    policyId: "attacker-selected-policy",
    policyRevision: 99,
  })

  // Then
  assert.equal(response.status, 400)
  const rows = await fixture.sql`select status,
    (select count(*)::integer from knowledge_reviews where proposal_id=${created.result.proposalId}) reviews,
    (select count(*)::integer from knowledge_objects where id='http-policy-target') canonical
    from knowledge_proposals where id=${created.result.proposalId}`
  assert.deepEqual([...rows], [{ status: "pending", reviews: 0, canonical: 0 }])
})

async function command(path: string, baseRevision: number | null, payload: unknown) {
  const response = await rawCommand(path, baseRevision, payload)
  assert.equal(response.status === 200 || response.status === 201, true, response.body)
  return CommandResultSchema.parse(JSON.parse(response.body))
}

async function rawCommand(path: string, baseRevision: number | null, payload: unknown) {
  const id = ++sequence
  return sendRawRequest({
    port,
    method: "POST",
    path: `/api/knowledge/v1/workspaces/workspace${path}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      commandId: `http-command-${id}`,
      idempotencyKey: `http-${id}`,
      baseRevision,
      payload,
    }),
  })
}

function get(path: string) {
  return sendRawRequest({
    port,
    method: "GET",
    path: `/api/knowledge/v1/workspaces/workspace${path}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

function claim(statement: string, status: "accepted" | "superseded") {
  return {
    type: "claim",
    title: statement,
    statement,
    status,
    confidence: 0.9,
    validityScope: "workspace",
  }
}
