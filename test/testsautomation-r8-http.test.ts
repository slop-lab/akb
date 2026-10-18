import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { z } from "zod"
import { automationEntityId } from "../src/automation/persistence.ts"
import { AutomationWorker } from "../src/automation/worker.ts"
import { createAutomationRoutes } from "../src/http/automation/index.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { ALL_WORK_PERMISSIONS } from "../src/identity/types.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createUnmigratedPostgresTestFixture } from "./postgres-fixture.ts"
import {
  assertAutomationTrigger,
  close,
  createAutomationApi,
  createCaptureTransport,
  listen,
  mapGitHubIssue,
  proveGitHubConsumed,
  proveGitHubWebhook,
  request,
  required,
  resultId,
  seedAutomationTemplate,
} from "./testsautomation-support.ts"
import {
  proveDisabledExtensionDenied,
  proveOutgoingDeadLetter,
  proveOutgoingLease,
} from "./testsautomation-worker-support.ts"

const database = await createUnmigratedPostgresTestFixture()
await migrateDatabase(database.sql)
after(database.close)

test("R8 authenticated HTTP and bounded worker execute intake, recurrence, automation, GitHub, analytics, and extensions", async () => {
  // Given
  const identity = new IdentityAdmin(database.sql)
  const credential = await identity.bootstrapWorkspace({
    workspaceId: "r8-workspace",
    workspaceName: "R8",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2099-01-01T00:00:00.000Z",
  })
  await identity.setPermissions({
    workspaceId: "r8-workspace",
    principalId: "owner",
    permissions: [...ALL_WORK_PERMISSIONS],
  })
  await new SpaceAdmin(database.sql).create({
    workspaceId: "r8-workspace",
    spaceId: "delivery",
    spaceName: "Delivery",
    visibility: "public",
  })
  const server = createAuthenticatedPostgresServer(
    database.sql,
    {
      newWorkItemId: () => workItemId(randomUUID()),
      newEventId: () => eventId(randomUUID()),
      now: () => new Date().toISOString(),
    },
    createAutomationRoutes(database.sql),
  )
  const origin = await listen(server)
  const api = createAutomationApi(origin, credential.token)
  try {
    assert.equal(
      (await fetch(`${origin}/api/automation/v1/workspaces/r8-workspace/analytics`)).status,
      401,
    )
    const stateRows = await database.sql<
      { readonly id: string }[]
    >`select id from workflow_states where workspace_id='r8-workspace' and space_id='delivery' and is_default`
    const stateId = required(stateRows[0]?.id)

    // When: intake is accepted through the authenticated HTTP surface.
    const intake = await api(
      "/api/automation/v1/workspaces/r8-workspace/intake",
      "POST",
      {
        source: "agent",
        sourceRef: "run-1",
        targetSpaceId: "delivery",
        title: "Investigate regression",
        body: "Observed by agent",
        suggestedDestination: null,
      },
      null,
      "intake-1",
    )
    assert.equal(intake.status, 201, await intake.clone().text())
    const intakeId = resultId(await intake.json())
    const accepted = await api(
      `/api/automation/v1/workspaces/r8-workspace/intake/${encodeURIComponent(intakeId)}/accept`,
      "POST",
      {
        ownerId: "owner",
        workflowStateId: stateId,
        projectId: null,
        itemType: "Bug",
        priority: "high",
      },
      1,
      "accept-1",
    )

    // Then: intake, work, revision, event, and outbox commit atomically.
    assert.equal(accepted.status, 200, await accepted.clone().text())
    const acceptedBody = z
      .object({ result: z.object({ workItemId: z.string() }) })
      .parse(await accepted.json())
    const workId = acceptedBody.result.workItemId
    const atomicRows = await database.sql<
      {
        readonly state: string
        readonly revisions: number
        readonly events: number
        readonly outbox: number
      }[]
    >`select intake.state,
      (select count(*)::integer from entity_revisions where entity_id in (${intakeId},${workId})) revisions,
      (select count(*)::integer from entity_events_v1 where subject_id in (${intakeId},${workId})) events,
      (select count(*)::integer from entity_outbox_events_v1 outbox join entity_events_v1 event on event.id=outbox.event_id where event.subject_id in (${intakeId},${workId})) outbox
      from intake_records intake where intake.id=${intakeId}`
    assert.deepEqual(atomicRows[0], { state: "accepted", revisions: 3, events: 3, outbox: 3 })

    // Given: immutable template revision, recurrence, approved extension, rule, and GitHub installation.
    const templateId = await seedAutomationTemplate(database.sql)
    const recurrence = await api(
      "/api/automation/v1/workspaces/r8-workspace/recurrences",
      "POST",
      {
        templateId,
        templateRevision: 1,
        targetSpaceId: "delivery",
        schedule: { kind: "daily", interval: 1 },
        timezone: "America/New_York",
        incompletePolicy: "skip",
        nextRunAt: "2026-10-17T12:00:00.000Z",
        title: "Daily review",
      },
      null,
      "recurrence-1",
    )
    assert.equal(recurrence.status, 201, await recurrence.clone().text())
    const manifest = await api(
      "/api/automation/v1/workspaces/r8-workspace/extensions/manifests",
      "POST",
      {
        id: "fixture.extension",
        version: "1.0.0",
        protocolVersion: "1",
        permissions: ["automation.read"],
        endpointUrl: "https://fixture.example/actions",
        eventSubscriptions: ["entity.created"],
        commands: [],
      },
      null,
      "manifest-1",
    )
    assert.equal(manifest.status, 201, await manifest.clone().text())
    const approval = await api(
      "/api/automation/v1/workspaces/r8-workspace/extensions/approvals",
      "POST",
      {
        manifestId: "fixture.extension",
        manifestVersion: "1.0.0",
        approvedPermissions: ["automation.read"],
      },
      null,
      "approval-1",
    )
    assert.equal(approval.status, 201, await approval.clone().text())
    const extensionId = automationEntityId("extension", "r8-workspace", "fixture.extension")
    const rule = await api(
      "/api/automation/v1/workspaces/r8-workspace/rules",
      "POST",
      {
        name: "Notify extension",
        enabled: true,
        trigger: { eventType: "entity.created" },
        conditions: [],
        actions: [{ kind: "webhook", endpointId: extensionId, body: { source: "automation" } }],
        maxRunsPerMinute: 60,
      },
      null,
      "rule-1",
    )
    assert.equal(rule.status, 201, await rule.clone().text())
    const github = await api(
      "/api/automation/v1/workspaces/r8-workspace/github/installations",
      "POST",
      {
        externalInstallationId: "42",
        repository: "acme/widgets",
        webhookSecret: "0123456789abcdef0123456789abcdef",
        apiBaseUrl: "https://api.github.com",
        allowedHosts: ["api.github.com"],
      },
      null,
      "github-1",
    )
    assert.equal(github.status, 201, await github.clone().text())
    const installationId = automationEntityId("github", "r8-workspace", "42")
    await mapGitHubIssue(api, installationId, workId)
    await assertAutomationTrigger(database.sql)

    // When: one bounded worker cycle runs with a local HTTP wire fixture transport.
    const fixture = await createCaptureTransport()
    const worker = new AutomationWorker(database.sql, fixture.transport)
    const result = await worker.runOnce(new Date("2026-10-17T12:00:00.000Z"), 100)
    await close(fixture.server)

    // Then: exact template revision is recorded once, event dedup holds, and delivery traversed HTTP.
    assert.equal(result.recurrences, 1)
    assert.ok(result.runs > 0, JSON.stringify(result))
    assert.ok(fixture.received.length > 0)
    const occurrence = await database.sql<
      { readonly template_revision: number; readonly outcome: string }[]
    >`select template_revision::integer template_revision,outcome from recurrence_occurrences`
    assert.deepEqual(occurrence[0], { template_revision: 1, outcome: "created" })
    await worker.runOnce(new Date("2026-10-17T12:00:00.000Z"), 100)
    assert.equal(
      (
        await database.sql<
          { readonly count: number }[]
        >`select count(*)::integer count from recurrence_occurrences`
      )[0]?.count,
      1,
    )
    const duplicateRuns = await database.sql<
      { readonly count: number }[]
    >`select count(*)::integer count from (select rule_id,event_id from automation_runs group by rule_id,event_id having count(*)>1) duplicate`
    assert.equal(duplicateRuns[0]?.count, 0)

    await assert.rejects(
      database.sql`update extension_manifests set protocol_version='2' where manifest_id='fixture.extension'`,
    )
    await proveOutgoingDeadLetter(database.sql, extensionId)
    await proveOutgoingLease(database.sql, extensionId)
    await proveDisabledExtensionDenied(database.sql, extensionId)

    await proveGitHubWebhook(database.sql, "0123456789abcdef0123456789abcdef")
    await proveGitHubConsumed(database.sql, installationId, workId)
    await database.sql`update work_item_pm set completed_at='2026-10-17T12:30:00Z' where work_item_id=${workId}`
    const analytics = await request(
      origin,
      "/api/automation/v1/workspaces/r8-workspace/analytics?metric=throughput&from=2026-10-17T00%3A00%3A00.000Z&to=2026-10-18T00%3A00%3A00.000Z",
      credential.token,
      "GET",
    )
    assert.equal(analytics.status, 200)
    assert.equal(z.object({ value: z.number() }).parse(await analytics.json()).value, 1)
  } finally {
    await close(server)
  }
})
