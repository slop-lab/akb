import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, test } from "node:test"
import {
  BootstrapSchema,
  HistoryEntrySchema,
  ProjectSchema,
  SpaceConfigSchema,
} from "../src/contracts/r4/index.ts"
import { HumanReadService } from "../src/human-query/read-service.ts"
import { HumanQueryService } from "../src/human-query/service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import type { AuthenticatedPrincipal } from "../src/identity/types.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let admin: IdentityAdmin
let viewer: AuthenticatedPrincipal

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  admin = new IdentityAdmin(fixture.sql)
  await admin.bootstrapWorkspace({
    workspaceId: "reads",
    workspaceName: "Reads",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await admin.provisionPrincipal({
    workspaceId: "reads",
    principalId: "viewer",
    displayName: "Viewer",
    kind: "human",
    role: "member",
    permissions: ["work.read", "space.read", "project.read", "history.read", "view.read"],
  })
  const viewerToken = await admin.issueToken({
    workspaceId: "reads",
    principalId: "viewer",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const authenticatedViewer = await authenticateToken(fixture.sql, viewerToken.token)
  if (authenticatedViewer === undefined) {
    throw new TypeError("fixture authentication failed")
  }
  viewer = authenticatedViewer
  await seedEntities()
})

afterEach(async () => fixture.close())

test("all Human reads reject a directly revoked credential", async () => {
  // Given
  const reads = new HumanReadService(fixture.sql)
  await fixture.sql`update principal_credentials set revoked_at=clock_timestamp()
    where id=${viewer.credentialId}`

  // When
  const results = await Promise.allSettled([
    reads.bootstrap(viewer),
    reads.spaces(viewer),
    reads.spaceConfig(viewer, "public"),
    reads.project(viewer, "project"),
    reads.projects(viewer),
    reads.history(viewer, "work"),
    reads.relations(viewer, "work"),
    reads.comments(viewer, "work"),
    reads.savedViews(viewer),
  ])

  // Then
  assert.equal(
    results.every((result) => result.status === "rejected"),
    true,
  )
  for (const result of results) {
    if (result.status === "rejected") {
      assert.equal(
        result.reason instanceof Error ? result.reason.name : null,
        "AuthenticationRequiredError",
      )
    }
  }
})

test("Human reads observe credential revocation committed while blocked", async () => {
  const reads = new HumanReadService(fixture.sql)

  await assert.rejects(
    revokeCredentialWhileBlocked(() => reads.bootstrap(viewer)),
    {
      name: "AuthenticationRequiredError",
    },
  )
})

test("authorized subjects return empty relation and comment collections", async () => {
  // Given
  const reads = new HumanReadService(fixture.sql)

  // When
  const [bootstrap, relations, comments] = await Promise.all([
    reads.bootstrap(viewer),
    reads.relations(viewer, "work"),
    reads.comments(viewer, "work"),
  ])

  // Then
  assert.deepEqual(BootstrapSchema.parse(bootstrap).principals, [{ id: "viewer", name: "Viewer" }])
  assert.deepEqual(relations, [])
  assert.deepEqual(comments, [])
})

test("comments require the containing thread ACL", async () => {
  await fixture.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at) values
    ('thread','reads','thread','public',1,'owner',now(),now()),
    ('comment','reads','comment','public',1,'owner',now(),now())`
  await fixture.sql`insert into entity_acl_policies values
    ('thread','restricted'),('comment','inherit')`
  await fixture.sql`insert into threads values('thread','reads','work',1)`
  await fixture.sql`insert into comments values
    ('comment','reads','thread','owner','Hidden',1,now(),now(),null)`

  const comments = await new HumanReadService(fixture.sql).comments(viewer, "work")

  assert.deepEqual(comments, [])
})

test("nested Project and private Space metadata require their own read authority", async () => {
  // Given
  await admin.setPermissions({
    workspaceId: "reads",
    principalId: "viewer",
    permissions: ["work.read", "space.read", "history.read"],
  })
  const reads = new HumanReadService(fixture.sql)
  const work = new HumanQueryService(fixture.sql, randomBytes(32))

  // When
  const [card, project, history] = await Promise.all([
    work.getWorkItem(viewer, "reads", "work"),
    reads.project(viewer, "project"),
    reads.history(viewer, "work"),
  ])

  // Then
  assert.equal(card?.project, null)
  assert.equal(project, undefined)
  const entries = HistoryEntrySchema.array().parse(history)
  const snapshot = entries[0]?.snapshot
  assert.equal(typeof snapshot === "object" && snapshot !== null && "project_id" in snapshot, false)
  assert.deepEqual(
    typeof snapshot === "object" && snapshot !== null
      ? Reflect.get(snapshot, "labelIds")
      : undefined,
    [],
  )
})

test("Project detail omits participating Spaces without private grants", async () => {
  // Given
  const reads = new HumanReadService(fixture.sql)

  // When
  const project = ProjectSchema.parse(await reads.project(viewer, "project"))

  // Then
  assert.deepEqual(project?.participatingSpaceIds, ["public"])
})

test("Space config exposes registry revisions without history permission", async () => {
  // Given
  await admin.setPermissions({
    workspaceId: "reads",
    principalId: "viewer",
    permissions: ["space.read"],
  })

  // When
  const config = SpaceConfigSchema.parse(
    await new HumanReadService(fixture.sql).spaceConfig(viewer, "public"),
  )

  // Then
  assert.equal(config?.space.revision, 1)
  assert.equal(config?.space.entityId.length > 0, true)
  assert.equal(
    config?.workflow.states.every((state) => state.revision === 1),
    true,
  )
})

test("Space config requires workflow entity authority", async () => {
  await fixture.sql`update entity_acl_policies set mode='restricted' where entity_id=(
    select id from workflows where workspace_id='reads' and space_id='public')`

  const config = await new HumanReadService(fixture.sql).spaceConfig(viewer, "public")

  assert.equal(config, undefined)
})

test("saved views omit definitions that reference unreadable entities", async () => {
  await admin.setPermissions({
    workspaceId: "reads",
    principalId: "viewer",
    permissions: ["work.read", "space.read", "history.read", "view.read"],
  })
  const definition = {
    model: "r4",
    filter: { op: "eq", field: "projectId", value: "project" },
    search: null,
    sort: [{ field: "updatedAt", direction: "desc" }],
    includeArchived: false,
    page: { size: 50, cursor: null },
  }
  await fixture.sql`insert into entities
    (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    values('view','reads','saved_view',1,'owner',now(),now())`
  await fixture.sql`insert into entity_acl_policies values('view','inherit')`
  await fixture.sql`insert into saved_views
    (id,workspace_id,owner_id,name,access,scope_space_id,definition,revision)
    values('view','reads','owner','Hidden project','workspace',null,${fixture.sql.json(definition)},1)`

  const views = await new HumanReadService(fixture.sql).savedViews(viewer)

  assert.deepEqual(views, [])
})

async function seedEntities(): Promise<void> {
  await fixture.sql`insert into spaces(workspace_id,id,name,visibility) values
    ('reads','public','Public','public'),('reads','private','Private','private')`
  await fixture.sql`select initialize_r4_space('reads','public','PUB','owner',true),
    initialize_r4_space('reads','private','PVT','owner',true)`
  await fixture.sql`insert into entities(id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    values('project','reads','project',1,'owner',now(),now())`
  await fixture.sql`insert into entity_acl_policies values('project','inherit')`
  await fixture.sql`insert into projects
    (id,workspace_id,name,slug,owner_id,state,health,priority,revision,created_at,updated_at)
    values('project','reads','Project','project','owner','active','on_track','none',1,now(),now())`
  await fixture.sql`insert into project_spaces values('project','reads','public'),('project','reads','private')`
  await fixture.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    select p.id,1,'project.r4.v1',to_jsonb(p)||jsonb_build_object(
      'participatingSpaceIds',jsonb_build_array('public','private')),'owner',p.updated_at,
      encode(public.digest(convert_to((to_jsonb(p)||jsonb_build_object(
        'participatingSpaceIds',jsonb_build_array('public','private')))::text,'utf8'),'sha256'),'hex')
    from projects p where p.id='project'`
  await fixture.sql`insert into work_items
    (id,workspace_id,space_id,title,state,accountable_owner_id,revision,created_at,updated_at)
    values('work','reads','public','Work','unstarted','owner',1,now(),now())`
  await fixture.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    select id,workspace_id,'work_item',space_id,revision,'owner',created_at,updated_at
    from work_items where id='work'`
  await fixture.sql`insert into entity_acl_policies values('work','inherit')`
  await fixture.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    values('secret-label','reads','label','public',1,'owner',now(),now())`
  await fixture.sql`insert into entity_acl_policies values('secret-label','restricted')`
  await fixture.sql`insert into labels(id,workspace_id,space_id,name,color,revision)
    values('secret-label','reads','public','Secret','red',1)`
  await fixture.sql`update work_item_pm set project_id='project' where work_item_id='work'`
  await fixture.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    select w.id,1,'work-item.r4.v1',snapshot.value,'owner',w.updated_at,
      encode(public.digest(convert_to(snapshot.value::text,'utf8'),'sha256'),'hex')
    from work_items w join work_item_pm pm on pm.work_item_id=w.id
    cross join lateral (select to_jsonb(w)||to_jsonb(pm)||jsonb_build_object(
      'labelIds',jsonb_build_array('secret-label')) value) snapshot
    where w.id='work'`
}

async function revokeCredentialWhileBlocked<T>(action: () => Promise<T>): Promise<T> {
  const connection = fixture.connect()
  let releaseRevocation: (() => void) | undefined
  const release = new Promise<void>((resolve) => {
    releaseRevocation = resolve
  })
  let reportLocked: (() => void) | undefined
  const locked = new Promise<void>((resolve) => {
    reportLocked = resolve
  })
  const revocation = connection.begin(async (transaction) => {
    await transaction`select id from principal_credentials where id=${viewer.credentialId} for update`
    reportLocked?.()
    await release
    await transaction`update principal_credentials set revoked_at=clock_timestamp()
      where id=${viewer.credentialId}`
  })
  await locked
  const operation = action()
  await new Promise<void>((resolve) => setImmediate(resolve))
  releaseRevocation?.()
  await revocation
  try {
    return await operation
  } finally {
    await connection.end()
  }
}
