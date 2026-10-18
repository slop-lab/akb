import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, before, test } from "node:test"
import { RunNotActiveError } from "../src/runtime/errors.ts"
import { authenticateRunToken } from "../src/runtime/principal.ts"
import { RuntimeWrites } from "../src/runtime/writes.ts"
import {
  createRuntimeRegressionHarness,
  type RuntimeRunAccess,
} from "./runtime-regression-support.ts"

type Revocation = "workspace" | "principal" | "membership" | "installation" | "endpoint"

let harness: Awaited<ReturnType<typeof createRuntimeRegressionHarness>>

before(async () => {
  harness = await createRuntimeRegressionHarness()
})

after(async () => harness.close())

for (const revocation of [
  "principal",
  "membership",
  "installation",
  "endpoint",
  "workspace",
] as const) {
  test(`runtime callbacks reject an existing run after ${revocation} revocation`, async () => {
    // Given
    const issued = await harness.startRun(`${revocation}-issued`, false)
    const stalePrincipal = await harness.sql.begin((transaction) =>
      authenticateRunToken(transaction, issued.token),
    )
    assert.notEqual(stalePrincipal, undefined)
    await revoke(revocation, issued)

    // When
    const staleAcknowledgement = new RuntimeWrites(harness.sql).acknowledge(
      stalePrincipal ?? assert.fail("run token did not authenticate"),
      1,
    )

    // Then
    await assert.rejects(staleAcknowledgement, RunNotActiveError)
    assert.equal(
      (await harness.client.runtime(issued.runId, "/lease/ack", issued.token, { generation: 1 }))
        .status,
      401,
    )
    await restore(revocation, issued)

    const active = await harness.startRun(`${revocation}-active`)
    await revoke(revocation, active)
    const bytes = Buffer.from("revoked artifact")
    const responses = await Promise.all([
      harness.client.runtime(active.runId, "/heartbeat", active.token, { generation: 1 }),
      harness.client.runtime(active.runId, "/activity", active.token, {
        generation: 1,
        idempotencyKey: `activity-${revocation}`,
        kind: "observation",
        durable: true,
        body: {},
        references: [],
        rawTraceRefs: [],
      }),
      harness.client.runtime(
        active.runId,
        "/plan",
        active.token,
        {
          generation: 1,
          idempotencyKey: `plan-${revocation}`,
          stepId: "step",
          parentStepId: null,
          title: "Blocked",
          status: "ready",
          dependsOn: [],
          resultRefs: [],
          baseRevision: 0,
        },
        "PUT",
      ),
      harness.client.runtime(active.runId, "/artifacts/chunks", active.token, {
        generation: 1,
        idempotencyKey: `artifact-${revocation}`,
        artifactId: `artifact-${revocation}`,
        kind: "report",
        mediaType: "text/plain",
        retentionClass: "durable",
        chunkIndex: 0,
        final: true,
        bytes: bytes.toString("base64"),
        digest: createHash("sha256").update(bytes).digest("hex"),
      }),
    ])
    assert.deepEqual(
      responses.map((response) => response.status),
      [401, 401, 401, 401],
    )
    await restore(revocation, active)
  })
}

async function revoke(kind: Revocation, run: RuntimeRunAccess): Promise<void> {
  switch (kind) {
    case "workspace":
      await harness.sql`update workspaces set status='archived' where id='runtime-workspace'`
      return
    case "principal":
      await harness.sql`update principals set status='disabled' where id=${`principal-${run.tag}`}`
      return
    case "membership":
      await harness.sql`update workspace_memberships set status='deactivated'
        where workspace_id='runtime-workspace' and principal_id=${`principal-${run.tag}`}`
      return
    case "installation":
      await harness.sql`update agent_installations set enabled=false
        where workspace_id='runtime-workspace' and id=${`installation-${run.tag}`}`
      return
    case "endpoint":
      await harness.sql`update runtime_endpoints set enabled=false
        where workspace_id='runtime-workspace' and id=${`endpoint-${run.tag}`}`
      return
  }
}

async function restore(kind: Revocation, run: RuntimeRunAccess): Promise<void> {
  switch (kind) {
    case "workspace":
      await harness.sql`update workspaces set status='active' where id='runtime-workspace'`
      return
    case "principal":
      await harness.sql`update principals set status='active' where id=${`principal-${run.tag}`}`
      return
    case "membership":
      await harness.sql`update workspace_memberships set status='active'
        where workspace_id='runtime-workspace' and principal_id=${`principal-${run.tag}`}`
      return
    case "installation":
      await harness.sql`update agent_installations set enabled=true
        where workspace_id='runtime-workspace' and id=${`installation-${run.tag}`}`
      return
    case "endpoint":
      await harness.sql`update runtime_endpoints set enabled=true
        where workspace_id='runtime-workspace' and id=${`endpoint-${run.tag}`}`
      return
  }
}
