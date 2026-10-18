import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, test } from "node:test"
import ky from "ky"
import { z } from "zod"
import type { BatchMutationResult } from "../src/entities/command-unit-of-work.ts"
import {
  createFeatureCommandRouter,
  type FeatureCommandCall,
  type FeatureCommandExecutor,
  featureCommandRoute,
} from "../src/http/feature-command-router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

type TestAction = "feature.create"
let fixture: UnmigratedPostgresTestFixture
let closeServer: () => Promise<void>

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
})

afterEach(async () => {
  await closeServer?.()
  await fixture.close()
})

test("authenticated feature router parses strict envelope and dispatches typed command", async () => {
  // Given
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "workspace",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  let dispatched: FeatureCommandCall<TestAction> | undefined
  const executor: FeatureCommandExecutor<TestAction> = {
    execute: async (call) => {
      dispatched = call
      return commandResult()
    },
  }
  const route = featureCommandRoute({
    method: "POST",
    pattern: /^\/api\/commands\/v1\/workspaces\/([^/]+)\/features$/,
    action: "feature.create",
    payload: z.strictObject({ name: z.string().min(1) }),
    create: true,
  })
  const server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused-work"),
      newEventId: () => eventId("unused-event"),
      now: () => "2026-10-17T00:00:00.000Z",
    },
    [createFeatureCommandRouter(fixture.sql, [route], executor)],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closeServer = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("server address missing")

  // When
  const response = await ky.post(commandUrl(address), {
    headers: { authorization: `Bearer ${issued.token}` },
    json: {
      commandId: "command-1",
      idempotencyKey: "feature-1",
      baseRevision: null,
      payload: { name: "Feature" },
    },
  })

  // Then
  assert.equal(response.status, 201)
  assert.equal(dispatched?.workspaceId, "workspace")
  assert.equal(dispatched?.principal.principalId, "owner")
  assert.deepEqual(dispatched?.payload, { name: "Feature" })
})

function commandUrl(address: AddressInfo): string {
  return `http://127.0.0.1:${address.port}/api/commands/v1/workspaces/workspace/features`
}

function commandResult(): BatchMutationResult {
  return {
    commandId: "command-1",
    eventId: "event-1",
    eventIds: ["event-1"],
    result: { id: "feature-1" },
    revision: 1,
    revisions: { "feature-1": 1 },
    replayed: false,
    warnings: [],
  }
}
