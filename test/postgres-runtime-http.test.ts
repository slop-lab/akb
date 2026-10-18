import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import type { Server } from "node:http"
import { createServer } from "node:http"
import { after, before, test } from "node:test"
import { z } from "zod"
import { createRuntimeRequestHandler } from "../src/http/runtime/request-handler.ts"
import { createRuntimeWorkspaceRoutes } from "../src/http/runtime/workspace-routes.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import type { PostgresTestFixture } from "./postgres-fixture.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"
import {
  close,
  listen,
  RuntimeHttpClient,
  responseItemIds,
  retrievalRequest,
  seedRuntimeEntities,
} from "./runtime-http-support.ts"

const signingKey = Buffer.alloc(32, 7)
let fixture: PostgresTestFixture
let humanServer: Server
let runtimeServer: Server
let humanOrigin: string
let runtimeOrigin: string
let humanToken: string
let client: RuntimeHttpClient

before(async () => {
  fixture = await createPostgresTestFixture()
  const credential = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "runtime-workspace",
    workspaceName: "Runtime Workspace",
    principalId: "runtime-owner",
    principalName: "Runtime Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  humanToken = credential.token
  await fixture.sql`insert into membership_permissions (workspace_id,principal_id,permission)
    values ('runtime-workspace','runtime-owner','admin.integrations'),
      ('runtime-workspace','runtime-owner','run.delegate'),
      ('runtime-workspace','runtime-owner','run.inspect')`
  humanServer = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId(randomUUID()),
      newEventId: () => eventId(randomUUID()),
      now: () => new Date().toISOString(),
    },
    createRuntimeWorkspaceRoutes(fixture.sql, signingKey),
  )
  runtimeServer = createServer((request, response) => {
    createRuntimeRequestHandler(fixture.sql, signingKey)(request, response)
      .then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
      .catch(() => response.writeHead(500).end())
  })
  humanOrigin = await listen(humanServer)
  runtimeOrigin = await listen(runtimeServer)
  client = new RuntimeHttpClient(humanOrigin, runtimeOrigin, humanToken)
})

after(async () => {
  await close(humanServer)
  await close(runtimeServer)
  await fixture.close()
})

test("authenticated HTTP runtime completes control, retrieval, and artifact flow", async () => {
  // Given
  await seedRuntimeEntities(fixture.sql)
  await human("/definitions", {
    definitionId: "definition",
    revisionId: "definition-v1",
    displayName: "Reference",
    roles: ["worker"],
    requiredCapabilities: ["context.read", "activity.write"],
    manifest: { version: 1 },
  })
  await human("/endpoints", {
    endpointId: "endpoint",
    protocolVersion: "runtime.v1",
    mode: "pull",
    supportedRoles: ["worker"],
    supportedCapabilities: ["context.read", "activity.write", "plan.write", "artifact.write"],
    maxConcurrency: 4,
    heartbeatSeconds: 30,
  })
  await human("/installations", {
    installationId: "installation",
    definitionRevisionId: "definition-v1",
    runtimeEndpointId: "endpoint",
    principalId: "runtime-principal",
    displayName: "Runtime",
    scopes: ["workspace"],
    permissions: ["work.read"],
    capabilities: ["context.read", "activity.write", "plan.write", "artifact.write"],
    mentionable: false,
    delegatable: true,
  })

  // When
  const started = await human("/runs", {
    installationId: "installation",
    subjectRef: "item-a",
    directiveRef: "complete item-a",
    idempotencyKey: "start-1",
    requestedCapabilities: ["context.read", "activity.write", "plan.write", "artifact.write"],
  })
  const runId = z.string().parse(started["runId"])
  const token = z.string().parse(started["runToken"])
  assert.equal((await runtime(runId, "/lease/ack", humanToken, { generation: 1 })).status, 401)
  assert.equal((await runtime(runId, "/lease/ack", token, { generation: 1 })).status, 200)
  const bootstrap = await runtimeJson(runId, "/bootstrap", token, undefined, "GET")
  const first = await runtimeJson(runId, "/retrieval", token, retrievalRequest(null))
  const cursor = z.string().parse(first["nextCursor"])
  const second = await runtimeJson(runId, "/retrieval", token, retrievalRequest(cursor))
  const expanded = await runtimeJson(runId, "/retrieval", token, {
    operation: "expand_entity",
    query: "",
    ids: ["item-a"],
    kinds: ["work_item"],
    projection: "detail",
    budget: { maxItems: 1, maxTokens: 10000 },
    cursor: null,
  })
  const receipt = z.string().uuid().parse(first["receiptId"])
  await fixture.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    values ('item-a',2,'test.v1','{"id":"item-a","title":"Alpha updated"}',
      'runtime-owner',clock_timestamp(),repeat('a',64))`
  await fixture.sql`update entities set current_revision=2,updated_at=clock_timestamp() where id='item-a'`
  const changed = await runtimeJson(runId, "/retrieval/delta", token, {
    sinceReceipt: receipt,
    kinds: ["work_item"],
    projection: "ref",
    budget: { maxItems: 10, maxTokens: 10000 },
  })
  await fixture.sql`update entity_acl_policies set mode='restricted' where entity_id='item-a'`
  const revoked = await runtimeJson(runId, "/retrieval/delta", token, {
    sinceReceipt: receipt,
    kinds: ["work_item"],
    projection: "ref",
    budget: { maxItems: 10, maxTokens: 10000 },
  })
  await fixture.sql`update entity_acl_policies set mode='inherit' where entity_id='item-a'`
  const firstIds = responseItemIds(first)
  const secondIds = responseItemIds(second)
  const activity = {
    generation: 1,
    idempotencyKey: "activity-1",
    kind: "observation",
    durable: true,
    body: { fact: "checked" },
    references: ["item-a"],
    rawTraceRefs: [],
  }
  const activityOne = await runtimeJson(runId, "/activity", token, activity)
  const activityTwo = await runtimeJson(runId, "/activity", token, activity)
  await runtimeJson(
    runId,
    "/plan",
    token,
    {
      generation: 1,
      idempotencyKey: "plan-1",
      stepId: "step-1",
      parentStepId: null,
      title: "Verify",
      status: "completed",
      dependsOn: [],
      resultRefs: ["item-a"],
      baseRevision: 0,
    },
    "PUT",
  )
  const bytes = Buffer.from("artifact evidence")
  await runtimeJson(runId, "/artifacts/chunks", token, {
    generation: 1,
    idempotencyKey: "artifact-1",
    artifactId: "artifact-1",
    kind: "report",
    mediaType: "text/plain",
    retentionClass: "durable",
    chunkIndex: 0,
    final: true,
    bytes: bytes.toString("base64"),
    digest: createHash("sha256").update(bytes).digest("hex"),
  })
  await runtimeJson(runId, "/activity", token, {
    ...activity,
    idempotencyKey: "question-1",
    kind: "question",
  })
  const awaiting = await humanGet(`/runs/${encodeURIComponent(runId)}`)
  const resumed = await human(`/runs/${encodeURIComponent(runId)}/resume`, {
    idempotencyKey: "resume-1",
    input: { answer: "continue" },
  })
  const resumedToken = z.string().parse(resumed["runToken"])
  const other = await human("/runs", {
    installationId: "installation",
    subjectRef: "item-b",
    directiveRef: "cross-token",
    idempotencyKey: "start-cross",
    requestedCapabilities: ["context.read", "activity.write"],
  })
  const otherRunId = z.string().parse(other["runId"])
  const crossTokenStatus = (
    await runtime(otherRunId, "/lease/ack", resumedToken, { generation: 1 })
  ).status
  const oldTokenStatus = (await runtime(runId, "/heartbeat", token, { generation: 1 })).status
  assert.equal((await runtime(runId, "/lease/ack", resumedToken, { generation: 2 })).status, 200)
  await human(`/runs/${encodeURIComponent(runId)}/cancel`, {})
  const canceledWrite = await runtime(runId, "/activity", resumedToken, {
    ...activity,
    generation: 2,
    idempotencyKey: "after-cancel",
  })

  // Then
  assert.equal(z.record(z.string(), z.unknown()).parse(bootstrap)["objective"], "complete item-a")
  assert.equal(firstIds.length, 1)
  assert.equal(secondIds.length, 1)
  assert.equal(new Set([...firstIds, ...secondIds]).size, 2)
  assert.equal(responseItemIds(expanded)[0], "item-a")
  assert.equal(z.array(z.unknown()).parse(changed["changed"]).length, 1)
  assert.equal(z.array(z.unknown()).parse(revoked["changed"]).length, 0)
  assert.deepEqual(revoked["omitted"], [
    { category: "restricted", count: "unknown", reason: "permission" },
  ])
  assert.deepEqual(activityOne, activityTwo)
  assert.equal(awaiting["state"], "awaiting_input")
  assert.equal(oldTokenStatus, 401)
  assert.equal(crossTokenStatus, 401)
  assert.equal(canceledWrite.status, 401)
})

async function human(path: string, body: unknown): Promise<Record<string, unknown>> {
  return client.human(path, body)
}

async function humanGet(path: string): Promise<Record<string, unknown>> {
  return client.humanGet(path)
}

async function runtimeJson(
  runId: string,
  path: string,
  token: string,
  body?: unknown,
  method = "POST",
): Promise<Record<string, unknown>> {
  return client.runtimeJson(runId, path, token, body, method)
}

function runtime(runId: string, path: string, token: string, body?: unknown, method = "POST") {
  return client.runtime(runId, path, token, body, method)
}
