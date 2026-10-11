import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Server } from "node:http"
import { after, beforeEach, test } from "node:test"
import { createEntityEventRouter } from "../src/http/entity-event-router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { runR4AdminCommand } from "../src/identity/r4-admin-cli.ts"
import { runRetentionCli } from "../src/operations/retention/cli.ts"
import { inspectRetention } from "../src/operations/retention/service.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
after(database.close)
beforeEach(database.reset)

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("missing address")
  return `http://127.0.0.1:${address.port}`
}

async function bootstrap() {
  const admin = new IdentityAdmin(database.sql)
  const owner = await admin.bootstrapWorkspace({
    workspaceId: "ops",
    workspaceName: "Operations",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await admin.provisionPrincipal({
    workspaceId: "ops",
    principalId: "reader",
    displayName: "Reader",
    kind: "human",
    role: "member",
    permissions: ["work.read"],
  })
  const reader = await admin.issueToken({
    workspaceId: "ops",
    principalId: "reader",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  return { admin, owner, reader }
}

async function seedProjectEvent(): Promise<void> {
  await database.sql`insert into entities
    (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    values ('project:secret','ops','project',1,'owner',clock_timestamp(),clock_timestamp())`
  await database.sql`insert into entity_acl_policies values ('project:secret','inherit')`
  await database.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    values ('project:secret',1,'project.r4.v1',${database.sql.json({ title: "private title" })},
      'owner',clock_timestamp(),repeat('0',64))`
  await database.sql`insert into entity_events_v1
    (id,workspace_id,sequence,event_type,subject_kind,subject_id,subject_revision,
      occurred_at,actor_id,data)
    values ('event-secret','ops',1,'entity.created','project','project:secret',1,
      clock_timestamp(),'owner',${database.sql.json({ id: "project:secret", title: "private title", token: "secret" })})`
}

test("generic replay denies incomplete authority before sequence metadata", async (context) => {
  // Given
  const { owner, reader } = await bootstrap()
  await seedProjectEvent()
  const server = createAuthenticatedPostgresServer(
    database.sql,
    {
      newWorkItemId: () => workItemId(randomUUID()),
      newEventId: () => eventId(randomUUID()),
      now: () => new Date().toISOString(),
    },
    [createEntityEventRouter(database.sql)],
  )
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const origin = await listen(server)
  const url = `${origin}/api/events/v1/workspaces/ops/events?after=0&limit=10`

  // When
  const denied = await fetch(url, { headers: { authorization: `Bearer ${reader.token}` } })
  const allowed = await fetch(url, { headers: { authorization: `Bearer ${owner.token}` } })

  // Then
  assert.equal(denied.status, 403)
  assert.deepEqual(await denied.json(), {
    error: {
      code: "permission_denied",
      message: "permission denied",
      retryable: false,
      details: {},
    },
  })
  const body = JSON.stringify(await allowed.json())
  assert.equal(allowed.status, 200)
  assert.match(body, /event-secret/)
  assert.doesNotMatch(body, /private title|\"title\"|\"token\"/)
})

test("retention dry-run reports only expired transient records without mutation", async () => {
  // Given
  const { owner } = await bootstrap()
  const snapshotId = randomUUID()
  const staleImport = randomUUID()
  const committedImport = randomUUID()
  await database.sql`insert into human_query_snapshots
    (id,workspace_id,principal_id,credential_id,query_hash,sort_hash,authority_hash,matched,
      created_at,expires_at) values (${snapshotId},'ops','owner',${owner.credentialId},repeat('1',64),
      repeat('2',64),repeat('3',64),0,'2026-01-01T00:00:00Z','2026-01-01T00:10:00Z')`
  await database.sql`insert into import_batches
    (import_id,workspace_id,principal_id,content_digest,byte_size,record_count,state,
      validation_expires_at,created_at) values (${staleImport},'ops','owner',repeat('4',64),1,1,
      'validated','2026-01-01T00:10:00Z','2026-01-01T00:00:00Z')`
  await database.sql`insert into import_batches
    (import_id,workspace_id,principal_id,content_digest,byte_size,record_count,state,
      validation_expires_at,committed_at,created_at) values (${committedImport},'ops','owner',
      repeat('5',64),1,1,'committed','2026-01-01T00:10:00Z','2026-01-01T00:05:00Z',
      '2026-01-01T00:00:00Z')`

  // When
  const report = await inspectRetention(database.sql, {
    workspaceId: "ops",
    resources: [
      "entities",
      "entity_revisions",
      "entity_events",
      "comments",
      "query_snapshots",
      "import_bookkeeping",
    ],
    now: new Date("2026-03-01T00:00:00.000Z"),
  })

  // Then
  assert.deepEqual(
    report.resources.map(({ resource, eligibleCount }) => [resource, eligibleCount]),
    [
      ["entities", 0],
      ["entity_revisions", 0],
      ["entity_events", 0],
      ["comments", 0],
      ["query_snapshots", 1],
      ["import_bookkeeping", 1],
    ],
  )
  assert.deepEqual(report.resources.at(-1)?.operatorIds, [staleImport])
  const counts = await database.sql`select
    (select count(*)::integer from human_query_snapshots) snapshots,
    (select count(*)::integer from import_batches) imports`
  assert.deepEqual(counts[0], { snapshots: 1, imports: 2 })
  assert.doesNotMatch(JSON.stringify(report), /owner|credential|digest|secret/i)
})

test("R4 administrator permission recovery grants the complete production bundle", async () => {
  // Given
  const { admin } = await bootstrap()
  await admin.setPermissions({ workspaceId: "ops", principalId: "reader", permissions: [] })

  // When
  const output = await runR4AdminCommand(
    "grant-r4-permissions",
    { "workspace-id": "ops", "principal-id": "reader" },
    database.sql,
  )

  // Then
  const rows = await database.sql<{ readonly permission: string }[]>`
    select permission from membership_permissions where workspace_id='ops'
      and principal_id='reader' order by permission`
  assert.equal(output, JSON.stringify({ granted: "reader" }))
  assert.equal(rows.length, 15)
  assert.ok(rows.some(({ permission }) => permission === "acl.manage"))
  assert.ok(rows.some(({ permission }) => permission === "project.read"))
  assert.ok(rows.some(({ permission }) => permission === "view.read"))
})

test("retention CLI has no canonical purge or apply command", async () => {
  // Given / When / Then
  await assert.rejects(runRetentionCli(["purge", "--workspace-id", "ops"], {}))
  await assert.rejects(runRetentionCli(["apply", "--workspace-id", "ops"], {}))
})
