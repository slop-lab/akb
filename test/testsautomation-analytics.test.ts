import assert from "node:assert/strict"
import { after, test } from "node:test"
import type { Sql } from "postgres"
import { AutomationAnalytics } from "../src/automation/analytics.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
after(database.close)

test("analytics excludes blocked work and run outcomes whose subjects are private", async () => {
  // Given
  const principal = await seedAnalyticsFixture(database.sql)
  const analytics = new AutomationAnalytics(database.sql)
  const interval = { from: "2026-10-17T00:00:00.000Z", to: "2026-10-18T00:00:00.000Z" }

  // When
  const blocked = await analytics.query(principal, { metric: "blocked", ...interval })
  const runs = await analytics.query(principal, { metric: "run_outcomes", ...interval })

  // Then
  assert.equal(blocked.value, 1)
  assert.equal(runs.value, 1)
})

async function seedAnalyticsFixture(sql: Sql) {
  const identity = new IdentityAdmin(sql)
  await identity.bootstrapWorkspace({
    workspaceId: "analytics-workspace",
    workspaceName: "Analytics",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2099-01-01T00:00:00.000Z",
  })
  await identity.provisionPrincipal({
    workspaceId: "analytics-workspace",
    principalId: "viewer",
    displayName: "Viewer",
    kind: "human",
    role: "member",
    permissions: ["work.read", "run.inspect"],
  })
  const credential = await identity.issueToken({
    workspaceId: "analytics-workspace",
    principalId: "viewer",
    expiresAt: "2099-01-01T00:00:00.000Z",
  })
  const spaces = new SpaceAdmin(sql)
  await spaces.create({
    workspaceId: "analytics-workspace",
    spaceId: "public",
    spaceName: "Public",
    visibility: "public",
  })
  await spaces.create({
    workspaceId: "analytics-workspace",
    spaceId: "private",
    spaceName: "Private",
    visibility: "private",
  })
  await seedAnalyticsEntities(sql)
  await seedRuntimeRows(sql)
  const principal = await authenticateToken(sql, credential.token)
  if (principal === undefined) throw new TypeError("analytics viewer authentication failed")
  return principal
}

async function seedAnalyticsEntities(sql: Sql): Promise<void> {
  await sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at) values
    ('visible-blocker','analytics-workspace','work_item','public',1,'owner',clock_timestamp(),clock_timestamp()),
    ('private-blocker','analytics-workspace','work_item','private',1,'owner',clock_timestamp(),clock_timestamp()),
    ('visible-target','analytics-workspace','work_item','public',1,'owner',clock_timestamp(),clock_timestamp()),
    ('hidden-target','analytics-workspace','work_item','public',1,'owner',clock_timestamp(),clock_timestamp()),
    ('visible-relation','analytics-workspace','relation',null,1,'owner',clock_timestamp(),clock_timestamp()),
    ('private-relation','analytics-workspace','relation',null,1,'owner',clock_timestamp(),clock_timestamp())`
  await sql`insert into entity_acl_policies(entity_id,mode)
    select id,'inherit' from entities where workspace_id='analytics-workspace'
    on conflict do nothing`
  await sql`insert into relations
    (id,workspace_id,from_entity_id,relation_type,to_entity_id,revision,asserted_by,valid_from) values
    ('visible-relation','analytics-workspace','visible-blocker','blocks','visible-target',1,'owner',clock_timestamp()),
    ('private-relation','analytics-workspace','private-blocker','blocks','hidden-target',1,'owner',clock_timestamp())`
  await sql`insert into entity_access_dependencies(entity_id,required_entity_id) values
    ('visible-relation','visible-blocker'),('visible-relation','visible-target'),
    ('private-relation','private-blocker'),('private-relation','hidden-target')`
}

async function seedRuntimeRows(sql: Sql): Promise<void> {
  await sql`insert into agent_definitions(workspace_id,id,display_name,created_by)
    values ('analytics-workspace','definition','Analytics agent','owner')`
  await sql`insert into agent_definition_revisions
    (id,workspace_id,definition_id,roles,required_capabilities,manifest,digest,created_by) values
    ('definition-v1','analytics-workspace','definition','[]','[]','{}',repeat('a',64),'owner')`
  await sql`insert into runtime_endpoints
    (workspace_id,id,protocol_version,mode,supported_roles,supported_capabilities,max_concurrency,heartbeat_seconds)
    values ('analytics-workspace','endpoint','runtime.v1','pull','[]','[]',1,30)`
  await sql`insert into agent_installations
    (workspace_id,id,definition_revision_id,runtime_endpoint_id,principal_id,scopes,permissions,
     capabilities,mentionable,delegatable,created_by) values
    ('analytics-workspace','installation','definition-v1','endpoint','owner','[]','[]','[]',false,true,'owner')`
  await sql`insert into runtime_sessions
    (id,workspace_id,installation_id,subject_ref,directive_ref,requester_id) values
    ('visible-session','analytics-workspace','installation','visible-target','visible','owner'),
    ('private-session','analytics-workspace','installation','private-blocker','private','owner')`
  await sql`insert into runtime_runs
    (id,workspace_id,session_id,installation_id,depth,state,generation,subject_ref,directive_ref,
     requester_id,policy_snapshot,token_hash,token_expires_at,created_at,updated_at) values
    ('visible-run','analytics-workspace','visible-session','installation',0,'completed',1,
      'visible-target','visible','owner','{}','visible','2099-01-01','2026-10-17T12:00:00Z',clock_timestamp()),
    ('private-run','analytics-workspace','private-session','installation',0,'completed',1,
      'private-blocker','private','owner','{}','private','2099-01-01','2026-10-17T12:00:00Z',clock_timestamp())`
}
