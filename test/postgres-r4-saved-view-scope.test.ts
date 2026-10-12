import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { HistoryEntrySchema } from "../src/contracts/r4/index.ts"
import { HumanReadService } from "../src/human-query/read-service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import type { AuthenticatedPrincipal } from "../src/identity/types.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { createUnmigratedPostgresTestFixture } from "./postgres-fixture.ts"
import { type R4CommandApi, resultId, startR4CommandApi } from "./r4-command-http-fixture.ts"

let fixture: Awaited<ReturnType<typeof createUnmigratedPostgresTestFixture>>
let api: R4CommandApi
let admin: IdentityAdmin
let viewer: AuthenticatedPrincipal
let viewerToken: string

const definition = {
  model: "r4",
  filter: null,
  search: "scoped",
  sort: [{ field: "updatedAt", direction: "desc" }],
  includeArchived: false,
  page: { size: 50, cursor: null },
} as const

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  api = await startR4CommandApi(fixture)
  admin = new IdentityAdmin(fixture.sql)
  await admin.provisionPrincipal({
    workspaceId: "w",
    principalId: "viewer",
    displayName: "Viewer",
    kind: "human",
    role: "member",
    permissions: ["space.read", "view.read", "view.manage", "history.read", "acl.manage"],
  })
  const issued = await admin.issueToken({
    workspaceId: "w",
    principalId: "viewer",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  viewerToken = issued.token
  const authenticated = await authenticateToken(fixture.sql, viewerToken)
  if (authenticated === undefined) throw new TypeError("viewer authentication failed")
  viewer = authenticated
  await space("public", "public")
  await space("private", "private")
})

afterEach(async () => {
  await api.close()
  await fixture.close()
})

test("Saved View history requires authority in its current Space", async () => {
  // Given
  const id = await movedView("public", "private")

  // When
  const history = await new HumanReadService(fixture.sql).history(viewer, id)

  // Then
  assert.equal(history, undefined)
})

test("Saved View archive denies a caller without current Space authority and writes nothing", async () => {
  // Given
  const id = await movedView("public", "private")

  // When
  const response = await api.sendWithToken(
    viewerToken,
    `/saved-views/${id}/archive`,
    "POST",
    2,
    {},
    "viewer-archive",
  )

  // Then
  assert.equal(response.status, 404)
  assert.deepEqual(await viewState(id), { revision: 2, archived_at: null })
})

test("Saved View ACL mutation denies a caller without current Space authority and preserves ACL", async () => {
  // Given
  const id = await movedView("public", "private")
  const before = await aclState(id)

  // When
  const response = await api.sendWithToken(
    viewerToken,
    `/entities/${id}/access`,
    "PUT",
    2,
    {
      mode: "restricted",
      allowances: [{ principalId: "viewer", permissions: ["view.read", "acl.manage"] }],
    },
    "viewer-acl",
  )

  // Then
  assert.equal(response.status, 404)
  assert.deepEqual(await aclState(id), before)
  assert.equal((await viewState(id)).revision, 2)
})

test("Saved View history redacts an unreadable historical scope and its definition", async () => {
  // Given
  const id = await movedView("public", "private")
  const moved = await api.send(
    `/saved-views/${id}`,
    "PATCH",
    2,
    { scopeSpaceId: "public" },
    "move-private-public",
  )
  assert.equal(moved.status, 200)
  const [authority] = await fixture.sql<
    {
      readonly original_scope: string | null
      readonly current_scope: string | null
      readonly private_allowed: boolean
    }[]
  >`select e.scope_space_id original_scope,v.scope_space_id current_scope,
    entity_access_allowed('w',stable_space_entity_id('w','private'),'viewer','space.read') private_allowed
    from entities e join saved_views v on v.id=e.id where e.id=${id}`
  assert.deepEqual(authority, {
    original_scope: "public",
    current_scope: "public",
    private_allowed: false,
  })

  // When
  const history = HistoryEntrySchema.array().parse(
    await new HumanReadService(fixture.sql).history(viewer, id),
  )

  // Then
  const historical = history.find((entry) => entry.revision === 2)?.snapshot ?? {}
  assert.equal(Object.hasOwn(historical, "scope_space_id"), false)
  assert.equal(Object.hasOwn(historical, "definition"), false)
  const current = history.find((entry) => entry.revision === 3)?.snapshot ?? {}
  assert.equal(Reflect.get(current, "scope_space_id"), "public")
  assert.deepEqual(Reflect.get(current, "definition"), definition)
})

async function space(id: string, visibility: "public" | "private"): Promise<void> {
  const response = await api.send(
    "/spaces",
    "POST",
    null,
    {
      id,
      key: id.slice(0, 3).toUpperCase(),
      name: id,
      visibility,
      description: "",
      icon: null,
      leadId: null,
    },
    `space-${id}`,
  )
  assert.equal(response.status, 201)
}

async function movedView(from: string, to: string): Promise<string> {
  const created = await api.send(
    "/saved-views",
    "POST",
    null,
    { name: "Scoped", access: "space", scopeSpaceId: from, definition },
    `view-${from}-${to}`,
  )
  const id = resultId(created.body)
  const moved = await api.send(
    `/saved-views/${id}`,
    "PATCH",
    1,
    { scopeSpaceId: to },
    `move-${from}-${to}`,
  )
  assert.equal(moved.status, 200)
  return id
}

async function viewState(
  id: string,
): Promise<{ readonly revision: number; readonly archived_at: string | null }> {
  const [row] = await fixture.sql<
    { readonly revision: number; readonly archived_at: string | null }[]
  >`
    select revision::integer,archived_at::text from saved_views where id=${id}`
  if (row === undefined) throw new TypeError("Saved View state missing")
  return row
}

async function aclState(id: string): Promise<readonly Record<string, unknown>[]> {
  return fixture.sql`select p.mode,a.principal_id,a.permission from entity_acl_policies p
    left join entity_acl_allowances a on a.entity_id=p.entity_id where p.entity_id=${id}
    order by a.principal_id,a.permission`
}
