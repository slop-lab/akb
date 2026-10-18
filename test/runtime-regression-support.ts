import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import { createRuntimeRequestHandler } from "../src/http/runtime/request-handler.ts"
import { createRuntimeWorkspaceRoutes } from "../src/http/runtime/workspace-routes.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"
import { close, listen, RuntimeHttpClient } from "./runtime-http-support.ts"

export type RuntimeRunAccess = {
  readonly runId: string
  readonly token: string
  readonly tag: string
}

export async function createRuntimeRegressionHarness() {
  const signingKey = Buffer.alloc(32, 9)
  const fixture = await createPostgresTestFixture()
  const credential = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "runtime-workspace",
    workspaceName: "Runtime Regression",
    principalId: "runtime-owner",
    principalName: "Runtime Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await fixture.sql`insert into membership_permissions (workspace_id,principal_id,permission)
    values ('runtime-workspace','runtime-owner','admin.integrations'),
      ('runtime-workspace','runtime-owner','run.delegate'),
      ('runtime-workspace','runtime-owner','run.inspect')`
  const humanServer = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId(randomUUID()),
      newEventId: () => eventId(randomUUID()),
      now: () => new Date().toISOString(),
    },
    createRuntimeWorkspaceRoutes(fixture.sql, signingKey),
  )
  const runtimeServer = createServer((request, response) => {
    createRuntimeRequestHandler(fixture.sql, signingKey)(request, response)
      .then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
      .catch(() => response.writeHead(500).end())
  })
  const client = new RuntimeHttpClient(
    await listen(humanServer),
    await listen(runtimeServer),
    credential.token,
  )
  await client.human("/definitions", {
    definitionId: "definition",
    revisionId: "definition-v1",
    displayName: "Regression worker",
    roles: ["worker"],
    requiredCapabilities: ["context.read", "activity.write"],
    manifest: { version: 1 },
  })

  async function startRun(tag: string, acknowledge = true): Promise<RuntimeRunAccess> {
    await client.human("/endpoints", {
      endpointId: `endpoint-${tag}`,
      protocolVersion: "runtime.v1",
      mode: "pull",
      supportedRoles: ["worker"],
      supportedCapabilities: ["context.read", "activity.write", "plan.write", "artifact.write"],
      maxConcurrency: 2,
      heartbeatSeconds: 30,
    })
    await client.human("/installations", {
      installationId: `installation-${tag}`,
      definitionRevisionId: "definition-v1",
      runtimeEndpointId: `endpoint-${tag}`,
      principalId: `principal-${tag}`,
      displayName: `Runtime ${tag}`,
      scopes: ["workspace"],
      permissions: ["work.read"],
      capabilities: ["context.read", "activity.write", "plan.write", "artifact.write"],
      mentionable: false,
      delegatable: true,
    })
    const started = await client.human("/runs", {
      installationId: `installation-${tag}`,
      subjectRef: "subject",
      directiveRef: `run ${tag}`,
      idempotencyKey: `start-${tag}`,
      requestedCapabilities: ["context.read", "activity.write", "plan.write", "artifact.write"],
    })
    const access = {
      runId: z.string().parse(started["runId"]),
      token: z.string().parse(started["runToken"]),
      tag,
    }
    if (acknowledge) {
      const response = await client.runtime(access.runId, "/lease/ack", access.token, {
        generation: 1,
      })
      if (!response.ok) throw new TypeError(`lease acknowledgement failed: ${response.status}`)
    }
    return access
  }

  return {
    sql: fixture.sql,
    client,
    startRun,
    close: async () => {
      await close(humanServer)
      await close(runtimeServer)
      await fixture.close()
    },
  }
}

export async function seedEntity(sql: Sql, id: string, title: string): Promise<void> {
  await sql`insert into entities
    (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    values (${id},'runtime-workspace','work_item',1,'runtime-owner',clock_timestamp(),clock_timestamp())`
  await sql`insert into entity_acl_policies values (${id},'inherit')`
  await sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    values (${id},1,'test.v1',${sql.json({ id, title })},'runtime-owner',clock_timestamp(),repeat('a',64))`
}
