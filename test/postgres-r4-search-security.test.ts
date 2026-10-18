import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { QueryBudgetExceededError, SnapshotConflictError } from "../src/human-query/service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { AuthenticationRequiredError } from "../src/identity/authorization-errors.ts"
import { createPostgresSearch } from "../src/search/postgres-search.ts"
import { InvalidCursorError } from "../src/search/search-binding.ts"
import {
  createSearchFixture,
  type SearchFixture,
  seedSecuritySearch,
} from "./postgres-r4-search-fixture.ts"

let fixture: SearchFixture

beforeEach(async () => {
  fixture = await createSearchFixture()
  await seedSecuritySearch(fixture)
})

afterEach(async () => fixture.database.close())

test("search excludes private and subject-denied documents before matched counts", async () => {
  // Given
  const search = createPostgresSearch(fixture.database.sql, fixture.signingKey)

  // When
  const page = await search.search(fixture.viewer, "search", {
    text: "visible OR privateonly OR commentonly",
    kinds: ["work_item", "comment"],
    limit: 100,
    cursor: null,
  })

  // Then
  assert.equal(page.matched, 1)
  assert.deepEqual(
    page.results.map((result) => result.title),
    ["Visible searchable"],
  )
  assert.deepEqual(Object.keys(page.results[0] ?? {}).sort(), [
    "id",
    "kind",
    "sourceRevision",
    "title",
  ])
})

test("comment search requires the read permission for its Project subject kind", async () => {
  // Given
  const project = await fixture.commands.execute({
    workspaceId: "search",
    principal: fixture.owner,
    commandId: "project-subject-create",
    idempotencyKey: "project-subject-create",
    baseRevision: null,
    action: "project.create",
    route: "project.create",
    resourceId: null,
    parentId: null,
    payload: {
      name: "Subject project",
      slug: "subject-project",
      summary: "",
      ownerId: "owner",
      leadIds: [],
      participatingSpaceIds: ["public"],
      state: "active",
      health: "on_track",
      priority: "none",
      startDate: null,
      targetDate: null,
    },
  })
  const projectId = Reflect.get(project.result, "id")
  if (typeof projectId !== "string") throw new TypeError("fixture Project ID missing")
  await fixture.execute("comment.create", projectId, null, null, { body: "Projectsubjectonly" })
  await fixture.database.sql`delete from membership_permissions
    where workspace_id='search' and principal_id='viewer' and permission='project.read'`
  const search = createPostgresSearch(fixture.database.sql, fixture.signingKey)

  // When
  const page = await search.search(fixture.viewer, "search", {
    text: "projectsubjectonly",
    kinds: ["comment"],
    limit: 10,
    cursor: null,
  })

  // Then
  assert.equal(page.matched, 0)
  assert.deepEqual(page.results, [])
})

test("search requires transitive dependency access before matched counts", async () => {
  // Given
  const states = await fixture.database.sql<{ readonly id: string }[]>`
    select id from workflow_states where workspace_id='search' and space_id='public' and is_default`
  const stateId = states[0]?.id
  if (stateId === undefined) throw new TypeError("fixture state missing")
  const dependencyId = await fixture.createWork(
    "public",
    stateId,
    "Search dependency",
    "search-dependency",
  )
  const childRows = await fixture.database.sql<{ readonly id: string }[]>`
    select id from work_items where workspace_id='search' and title='Visible searchable'`
  const childId = childRows[0]?.id
  if (childId === undefined) throw new TypeError("fixture searchable Work Item missing")
  await fixture.database.sql`update entity_acl_policies set mode='restricted'
    where entity_id=${dependencyId}`
  await fixture.database.sql`insert into entity_acl_allowances(entity_id,principal_id,permission)
    values (${dependencyId},'owner','work.read')`
  await fixture.database.sql`insert into entity_access_dependencies(entity_id,required_entity_id)
    values (${childId},${dependencyId})`
  const search = createPostgresSearch(fixture.database.sql, fixture.signingKey)

  // When
  const denied = await search.search(fixture.viewer, "search", {
    text: "visible",
    kinds: ["work_item"],
    limit: 10,
    cursor: null,
  })
  await fixture.database.sql`insert into entity_acl_allowances(entity_id,principal_id,permission)
    values (${dependencyId},'viewer','work.read')`
  const allowed = await search.search(fixture.viewer, "search", {
    text: "visible",
    kinds: ["work_item"],
    limit: 10,
    cursor: null,
  })

  // Then
  assert.equal(denied.matched, 0)
  assert.equal(allowed.matched, 1)
  assert.equal(allowed.results[0]?.title, "Visible searchable")
})

test("100001 authorized matches reject search before snapshot persistence", async () => {
  // Given
  await fixture.database.sql`insert into entities
      (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    select 'search-scale-'||lpad(value::text,6,'0'),'search','work_item',1,'owner',
      clock_timestamp(),clock_timestamp() from generate_series(1,100001) value`
  await fixture.database.sql`alter table entity_acl_policies disable trigger entity_policy_epoch`
  await fixture.database.sql`insert into entity_acl_policies(entity_id,mode)
    select id,'inherit' from entities where id like 'search-scale-%'`
  await fixture.database.sql`alter table entity_acl_policies enable trigger entity_policy_epoch`
  await fixture.database.sql`insert into search_documents
      (entity_id,workspace_id,kind,source_revision,document)
    select id,'search','work_item',1,to_tsvector('simple','Scalebudget')
    from entities where id like 'search-scale-%'`
  const search = createPostgresSearch(fixture.database.sql, fixture.signingKey)

  // When / Then
  await assert.rejects(
    search.search(fixture.viewer, "search", {
      text: "scalebudget",
      kinds: ["work_item"],
      limit: 100,
      cursor: null,
    }),
    QueryBudgetExceededError,
  )
  const snapshots = await fixture.database.sql<{ readonly count: number }[]>`
    select count(*)::integer count from human_query_snapshots where workspace_id='search'`
  assert.equal(snapshots[0]?.count, 0)
})

test("continuation binds canonical query kinds and page size", async () => {
  // Given
  const search = createPostgresSearch(fixture.database.sql, fixture.signingKey)
  const first = await search.search(fixture.owner, "search", {
    text: "searchable",
    kinds: ["work_item"],
    limit: 1,
    cursor: null,
  })
  const cursor = requiredCursor(first.nextCursor)

  // When / Then
  await assert.rejects(
    search.search(fixture.owner, "search", {
      text: "different",
      kinds: ["work_item"],
      limit: 1,
      cursor,
    }),
    SnapshotConflictError,
  )
  await assert.rejects(
    search.search(fixture.owner, "search", {
      text: "searchable",
      kinds: ["comment", "work_item"],
      limit: 1,
      cursor,
    }),
    SnapshotConflictError,
  )
  await assert.rejects(
    search.search(fixture.owner, "search", {
      text: "searchable",
      kinds: ["work_item"],
      limit: 2,
      cursor,
    }),
    SnapshotConflictError,
  )
})

test("continuation rejects tampering actors credentials epochs and database expiry", async () => {
  // Given
  const search = createPostgresSearch(fixture.database.sql, fixture.signingKey)
  const request = {
    text: "searchable",
    kinds: ["work_item"] as const,
    limit: 1,
    cursor: null,
  }
  const first = await search.search(fixture.owner, "search", request)
  const cursor = requiredCursor(first.nextCursor)
  // Flip a full signature byte, not the final base64url character's padding bits.
  const signatureStart = cursor.lastIndexOf(".") + 1
  const tamperedCursor =
    cursor.slice(0, signatureStart) +
    (cursor[signatureStart] === "A" ? "B" : "A") +
    cursor.slice(signatureStart + 1)

  // When / Then
  await assert.rejects(
    search.search(fixture.owner, "search", { ...request, cursor: tamperedCursor }),
    InvalidCursorError,
  )
  await assert.rejects(
    search.search(fixture.viewer, "search", { ...request, cursor }),
    SnapshotConflictError,
  )
  const secondCredential = await new IdentityAdmin(fixture.database.sql).issueToken({
    workspaceId: "search",
    principalId: "owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const sameActor = await authenticateToken(fixture.database.sql, secondCredential.token)
  if (sameActor === undefined) throw new TypeError("fixture authentication failed")
  await assert.rejects(
    search.search(sameActor, "search", { ...request, cursor }),
    SnapshotConflictError,
  )
  await fixture.database
    .sql`update workspace_authority_epochs set epoch=epoch+1 where workspace_id='search'`
  await assert.rejects(
    search.search(fixture.owner, "search", { ...request, cursor }),
    SnapshotConflictError,
  )
  await fixture.database
    .sql`update workspace_authority_epochs set epoch=epoch-1 where workspace_id='search'`
  await fixture.database
    .sql`update human_query_snapshots set created_at=clock_timestamp()-interval '10 minutes',
    expires_at=clock_timestamp()-interval '1 minute' where id=${first.snapshot.id}::uuid`
  await assert.rejects(
    search.search(fixture.owner, "search", { ...request, cursor }),
    (error: unknown) => error instanceof SnapshotConflictError && error.code === "snapshot_expired",
  )
})

test("search revalidates a revoked credential inside its transaction", async () => {
  // Given
  const search = createPostgresSearch(fixture.database.sql, fixture.signingKey)
  await new IdentityAdmin(fixture.database.sql).revokeToken({
    credentialId: fixture.owner.credentialId,
  })

  // When / Then
  await assert.rejects(
    search.search(fixture.owner, "search", {
      text: "searchable",
      kinds: ["work_item"],
      limit: 10,
      cursor: null,
    }),
    AuthenticationRequiredError,
  )
})

test("search revalidates a disabled principal inside its transaction", async () => {
  // Given
  const search = createPostgresSearch(fixture.database.sql, fixture.signingKey)
  await fixture.database.sql`update principals set status='disabled'
    where workspace_id='search' and id='owner'`

  // When / Then
  await assert.rejects(
    search.search(fixture.owner, "search", {
      text: "searchable",
      kinds: ["work_item"],
      limit: 10,
      cursor: null,
    }),
    AuthenticationRequiredError,
  )
})

function requiredCursor(value: string | null): string {
  if (value === null) throw new TypeError("fixture did not produce a continuation")
  return value
}
