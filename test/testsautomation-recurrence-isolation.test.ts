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
  type AutomationApi,
  close,
  createAutomationApi,
  listen,
  resultId,
} from "./testsautomation-support.ts"

const database = await createUnmigratedPostgresTestFixture()
await migrateDatabase(database.sql)
after(database.close)

test("bad recurrence rules are disabled without blocking healthy rules or later worker lanes", async () => {
  // Given
  const identity = new IdentityAdmin(database.sql)
  const owner = await identity.bootstrapWorkspace({
    workspaceId: "recurrence-workspace",
    workspaceName: "Recurrence isolation",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2099-01-01T00:00:00.000Z",
  })
  await identity.setPermissions({
    workspaceId: "recurrence-workspace",
    principalId: "owner",
    permissions: [...ALL_WORK_PERMISSIONS],
  })
  await new SpaceAdmin(database.sql).create({
    workspaceId: "recurrence-workspace",
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
  const api = createAutomationApi(origin, owner.token)
  try {
    const templateId = automationEntityId("planning-template", "recurrence-workspace", "fixture")
    await seedTemplate(templateId)
    await proveInvalidScheduleBoundaries(api, templateId)

    const invalidTimezoneId = await createRecurrence(api, templateId, {
      key: "invalid-timezone",
      nextRunAt: "2026-03-07T06:00:00.000Z",
      title: "Invalid timezone",
    })
    await database.sql`update recurrence_rules set timezone='Not/A_Timezone'
      where id=${invalidTimezoneId}`

    await identity.provisionPrincipal({
      workspaceId: "recurrence-workspace",
      principalId: "revoked-owner",
      displayName: "Revoked owner",
      kind: "human",
      role: "admin",
      permissions: [...ALL_WORK_PERMISSIONS],
    })
    const revoked = await identity.issueToken({
      workspaceId: "recurrence-workspace",
      principalId: "revoked-owner",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })
    const revokedId = await createRecurrence(
      createAutomationApi(origin, revoked.token),
      templateId,
      { key: "revoked-owner", nextRunAt: "2026-03-07T06:30:00.000Z", title: "Revoked" },
    )
    await identity.revokeToken({ credentialId: revoked.credentialId })

    const healthyId = await createRecurrence(api, templateId, {
      key: "healthy-dst",
      nextRunAt: "2026-03-07T07:30:00.000Z",
      title: "Healthy DST",
    })
    const installationId = await seedLaterLanes(api)
    await database.sql`insert into github_webhook_deliveries
      (installation_id,delivery_id,event_name,payload,received_at,available_at)
      values (${installationId},'unmapped','issues',
        '{"action":"opened","issue":{"number":99,"title":"Unmapped"}}',
        '2026-03-07T05:00:00Z','2026-03-07T05:00:00Z')`
    const extensionId = automationEntityId("extension", "recurrence-workspace", "fixture.extension")
    await database.sql`insert into outgoing_https_requests
      (workspace_id,idempotency_key,endpoint_kind,endpoint_id,url,method,body,state,available_at,created_at)
      values ('recurrence-workspace','recurrence-isolation','extension',${extensionId},
        'https://fixture.example/actions','POST','{}','pending',
        '2026-03-07T05:00:00Z','2026-03-07T05:00:00Z')`
    let sends = 0
    const worker = new AutomationWorker(database.sql, {
      async send() {
        sends += 1
        return 204
      },
    })

    // When
    const result = await worker.runOnce(new Date("2026-03-07T08:00:00.000Z"), 10)

    // Then
    assert.equal(result.recurrences, 3)
    assert.equal(result.githubDeliveries, 1)
    assert.equal(result.deliveries, 1)
    assert.equal(sends, 1)
    const rules = await database.sql<
      { readonly id: string; readonly enabled: boolean; readonly next_run_at: Date }[]
    >`select id,enabled,next_run_at from recurrence_rules
      where id in (${invalidTimezoneId},${revokedId},${healthyId}) order by id`
    const byId = new Map(rules.map((rule) => [rule.id, rule]))
    assert.equal(byId.get(invalidTimezoneId)?.enabled, false)
    assert.equal(byId.get(revokedId)?.enabled, false)
    assert.equal(byId.get(healthyId)?.enabled, true)
    assert.equal(byId.get(healthyId)?.next_run_at.toISOString(), "2026-03-08T07:00:00.000Z")
    const occurrences = await database.sql<
      { readonly count: number }[]
    >`select count(*)::integer count from recurrence_occurrences where rule_id=${healthyId}`
    assert.equal(occurrences[0]?.count, 1)
    await worker.runOnce(new Date("2026-03-07T08:00:00.000Z"), 10)
    const duplicates = await database.sql<
      { readonly count: number }[]
    >`select count(*)::integer count from recurrence_occurrences where rule_id=${healthyId}`
    assert.equal(duplicates[0]?.count, 1)
    const checkpoints = await database.sql<
      { readonly last_sequence: number }[]
    >`select last_sequence::integer last_sequence from automation_event_checkpoints
      where workspace_id='recurrence-workspace'`
    assert.ok((checkpoints[0]?.last_sequence ?? 0) > 0)
  } finally {
    await close(server)
  }
})

async function seedTemplate(templateId: string): Promise<void> {
  await database.sql.begin(async (transaction) => {
    await transaction`insert into entities(id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
      values (${templateId},'recurrence-workspace','planning_template',1,'owner',clock_timestamp(),clock_timestamp())`
    await transaction`insert into entity_acl_policies values (${templateId},'inherit')`
    await transaction`insert into planning_templates
      (id,workspace_id,name,kind,current_revision,created_by,created_at,updated_at)
      values (${templateId},'recurrence-workspace','Fixture','work',1,'owner',clock_timestamp(),clock_timestamp())`
    await transaction`insert into planning_template_revisions(template_id,revision,content,actor_id,created_at)
      values (${templateId},1,'{}','owner',clock_timestamp())`
  })
}

async function createRecurrence(
  api: AutomationApi,
  templateId: string,
  input: { readonly key: string; readonly nextRunAt: string; readonly title: string },
): Promise<string> {
  const response = await api(
    "/api/automation/v1/workspaces/recurrence-workspace/recurrences",
    "POST",
    {
      templateId,
      templateRevision: 1,
      targetSpaceId: "delivery",
      schedule: { kind: "daily", interval: 1 },
      timezone: "America/New_York",
      incompletePolicy: "create",
      nextRunAt: input.nextRunAt,
      title: input.title,
    },
    null,
    input.key,
  )
  assert.equal(response.status, 201, await response.clone().text())
  return resultId(await response.json())
}

async function proveInvalidScheduleBoundaries(
  api: AutomationApi,
  templateId: string,
): Promise<void> {
  const payload = {
    templateId,
    templateRevision: 1,
    targetSpaceId: "delivery",
    schedule: { kind: "daily", interval: 1 },
    timezone: "Not/A_Timezone",
    incompletePolicy: "create",
    nextRunAt: "2026-03-07T07:30:00.000Z",
    title: "Invalid",
  }
  const timezone = await api(
    "/api/automation/v1/workspaces/recurrence-workspace/recurrences",
    "POST",
    payload,
  )
  assert.equal(timezone.status, 400)
  const cron = await api("/api/automation/v1/workspaces/recurrence-workspace/recurrences", "POST", {
    ...payload,
    timezone: "UTC",
    schedule: { kind: "cron", expression: "60 24 * * 0" },
  })
  assert.equal(cron.status, 400)
}

async function seedLaterLanes(api: AutomationApi): Promise<string> {
  const github = await api(
    "/api/automation/v1/workspaces/recurrence-workspace/github/installations",
    "POST",
    {
      externalInstallationId: "42",
      repository: "acme/widgets",
      webhookSecret: "0123456789abcdef0123456789abcdef",
      apiBaseUrl: "https://api.github.com",
      allowedHosts: ["api.github.com"],
    },
  )
  assert.equal(github.status, 201, await github.clone().text())
  const manifest = await api(
    "/api/automation/v1/workspaces/recurrence-workspace/extensions/manifests",
    "POST",
    {
      id: "fixture.extension",
      version: "1.0.0",
      protocolVersion: "1",
      permissions: ["automation.read"],
      endpointUrl: "https://fixture.example/actions",
      eventSubscriptions: [],
      commands: [],
    },
  )
  assert.equal(manifest.status, 201, await manifest.clone().text())
  const approval = await api(
    "/api/automation/v1/workspaces/recurrence-workspace/extensions/approvals",
    "POST",
    {
      manifestId: "fixture.extension",
      manifestVersion: "1.0.0",
      approvedPermissions: ["automation.read"],
    },
  )
  assert.equal(approval.status, 201, await approval.clone().text())
  return z.object({ result: z.object({ id: z.string() }) }).parse(await github.json()).result.id
}
