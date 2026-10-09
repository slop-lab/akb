import assert from "node:assert/strict"
import { test } from "node:test"
import { RawSpaceIdSchema, spaceId } from "../src/work-items/identifiers.ts"
import { InMemoryWorkItemStore } from "../src/work-items/in-memory-store.ts"
import { createFingerprint } from "../src/work-items/create-fingerprint.ts"
import { ADMIN_HELP, runAdminCli } from "../src/identity/admin-cli.ts"
import { jsonRequest, startHttpFixtureWithStore } from "./http-fixture.ts"
import {
  actorId,
  eventId,
  humanPrincipalId,
  idempotencyKey,
  workItemId,
  workItemTitle,
  workspaceId,
} from "../src/work-items/identifiers.ts"

test("SpaceId accepts at most 128 Unicode code points", () => {
  // Given
  const valid = "😀".repeat(128)
  const invalid = `${valid}😀`

  // When
  const parsed = spaceId(valid)

  // Then
  assert.equal(parsed, valid)
  assert.equal(RawSpaceIdSchema.safeParse(invalid).success, false)
})

test("legacy create fingerprint bytes remain unchanged and scoped commands append SpaceId", () => {
  // Given
  const legacy = {
    workspaceId: workspaceId("workspace"),
    title: workItemTitle("Title"),
    accountableOwnerId: humanPrincipalId("owner"),
    actorId: actorId("actor"),
    idempotencyKey: idempotencyKey("key"),
  }

  // When
  const unscoped = createFingerprint(legacy)
  const scoped = createFingerprint({ ...legacy, spaceId: spaceId("space") })

  // Then
  assert.equal(
    unscoped,
    '{"workspaceId":"workspace","title":"Title","accountableOwnerId":"owner","actorId":"actor"}',
  )
  assert.equal(
    scoped,
    '{"workspaceId":"workspace","title":"Title","accountableOwnerId":"owner","actorId":"actor","spaceId":"space"}',
  )
})

test("in-memory HTTP scoped create is rejected before dependencies mutate", async (context) => {
  // Given
  let generatedItems = 0
  let generatedEvents = 0
  let clockReads = 0
  const store = new InMemoryWorkItemStore({
    newWorkItemId: () => {
      generatedItems += 1
      return workItemId("item")
    },
    newEventId: () => {
      generatedEvents += 1
      return eventId("event")
    },
    now: () => {
      clockReads += 1
      return "2026-10-09T12:00:00.000Z"
    },
  })

  const fixture = await startHttpFixtureWithStore(store)
  context.after(fixture.close)

  // When
  const response = await fixture.request(
    "/api/workspaces/workspace/work-items",
    jsonRequest(
      {
        title: workItemTitle("Scoped"),
        accountableOwnerId: humanPrincipalId("owner"),
        actorId: actorId("actor"),
        spaceId: spaceId("private"),
      },
      idempotencyKey("key"),
    ),
  )

  // Then
  assert.equal(response.status, 400)
  assert.deepEqual([generatedItems, generatedEvents, clockReads], [0, 0, 0])
})

test("administrator CLI documents Space commands and rejects malformed options before connecting", async () => {
  // Given
  const commands = ["create-space", "set-space-visibility", "set-space-permissions"]

  // When / Then
  assert.equal(
    commands.every((command) => ADMIN_HELP.includes(command)),
    true,
  )
  await assert.rejects(runAdminCli(["create-space", "--workspace-id"], {}), TypeError)
})
