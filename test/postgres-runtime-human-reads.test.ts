import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, before, test } from "node:test"
import { z } from "zod"
import { IdentityAdmin } from "../src/identity/admin.ts"
import type { RuntimeHttpClient } from "./runtime-http-support.ts"
import { createRuntimeRegressionHarness, seedEntity } from "./runtime-regression-support.ts"

let harness: Awaited<ReturnType<typeof createRuntimeRegressionHarness>>
let viewer: RuntimeHttpClient

before(async () => {
  harness = await createRuntimeRegressionHarness()
  const identity = new IdentityAdmin(harness.sql)
  await identity.provisionPrincipal({
    workspaceId: "runtime-workspace",
    principalId: "runtime-viewer",
    displayName: "Runtime Viewer",
    kind: "human",
    role: "member",
    permissions: ["work.read", "run.delegate", "run.inspect"],
  })
  const credential = await identity.issueToken({
    workspaceId: "runtime-workspace",
    principalId: "runtime-viewer",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  viewer = harness.client.withHumanToken(credential.token)
})

after(async () => harness.close())

test("run control hides runs when the subject is no longer readable", async () => {
  // Given
  const run = await harness.startRun("subject-acl")
  await harness.sql`update entity_acl_policies set mode='restricted' where entity_id='subject'`

  // When
  const responses = await Promise.all([
    viewer.humanResponse(`/runs/${encodeURIComponent(run.runId)}`, undefined, "GET"),
    viewer.humanResponse(`/runs/${encodeURIComponent(run.runId)}/cancel`, {}),
    viewer.humanResponse(`/runs/${encodeURIComponent(run.runId)}/resume`, {
      idempotencyKey: "hidden-resume",
    }),
  ])

  // Then
  assert.deepEqual(
    responses.map((response) => response.status),
    [404, 404, 404],
  )
})

test("run start requires both requester and installation subject access", async () => {
  // Given
  await harness.sql`update entity_acl_policies set mode='inherit' where entity_id='subject'`
  await seedEntity(harness.sql, "private-subject", "Private subject")
  await harness.sql`update entity_acl_policies set mode='restricted' where entity_id='private-subject'`
  await harness.startRun("private-installation")

  // When
  const response = await harness.client.humanResponse("/runs", {
    installationId: "installation-private-installation",
    subjectRef: "private-subject",
    directiveRef: "must remain hidden",
    idempotencyKey: "private-start",
    requestedCapabilities: ["context.read"],
  })

  // Then
  assert.equal(response.status, 404)
})

test("run policy uses the current installation and endpoint capability intersection", async () => {
  // Given
  await harness.sql`update entity_acl_policies set mode='inherit' where entity_id='subject'`
  await harness.startRun("capability-intersection")
  await harness.sql`update runtime_endpoints set supported_capabilities='["context.read","activity.write"]'
    where workspace_id='runtime-workspace' and id='endpoint-capability-intersection'`

  // When
  const started = await harness.client.human("/runs", {
    installationId: "installation-capability-intersection",
    subjectRef: "subject",
    directiveRef: "current capabilities only",
    idempotencyKey: "capability-intersection-current",
    requestedCapabilities: [],
  })

  // Then
  const rows = await harness.sql<{ readonly capabilities: unknown }[]>`
    select policy_snapshot->'capabilities' capabilities from runtime_runs
    where id=${z.string().parse(started["runId"])}`
  assert.deepEqual(z.array(z.string()).parse(rows[0]?.capabilities), [
    "context.read",
    "activity.write",
  ])
})

test("human activity receipt and artifact reads are bounded and omit run tokens", async () => {
  // Given
  await harness.sql`update entity_acl_policies set mode='inherit' where entity_id='subject'`
  const run = await harness.startRun("human-reads")
  await harness.client.runtimeJson(run.runId, "/activity", run.token, {
    generation: 1,
    idempotencyKey: "read-activity",
    kind: "observation",
    durable: true,
    body: { status: "visible" },
    references: ["subject"],
    rawTraceRefs: [],
  })
  const bytes = Buffer.from("visible artifact")
  await harness.client.runtimeJson(run.runId, "/artifacts/chunks", run.token, {
    generation: 1,
    idempotencyKey: "read-artifact",
    artifactId: "artifact-human-read",
    kind: "report",
    mediaType: "text/plain",
    retentionClass: "durable",
    chunkIndex: 0,
    final: true,
    bytes: bytes.toString("base64"),
    digest: createHash("sha256").update(bytes).digest("hex"),
  })
  await harness.client.runtimeJson(run.runId, "/retrieval", run.token, {
    operation: "read_entities",
    query: "",
    ids: ["subject"],
    kinds: ["work_item"],
    projection: "ref",
    budget: { maxItems: 1, maxTokens: 1000 },
    cursor: null,
  })

  // When
  const [activity, receipts, artifacts] = await Promise.all([
    viewer.humanGet(`/runs/${encodeURIComponent(run.runId)}/activity?limit=1`),
    viewer.humanGet(`/runs/${encodeURIComponent(run.runId)}/receipts?limit=1`),
    viewer.humanGet(`/runs/${encodeURIComponent(run.runId)}/artifacts?limit=1`),
  ])

  // Then
  for (const page of [activity, receipts, artifacts]) {
    assert.equal(z.array(z.unknown()).parse(page["items"]).length, 1)
    assert.equal(JSON.stringify(page).includes("runToken"), false)
  }
})
