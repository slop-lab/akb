import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import type { WorkPermission } from "../src/identity/types.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"
import { type R4CommandApi, resultId, startR4CommandApi } from "./r4-command-http-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let api: R4CommandApi

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  api = await startR4CommandApi(fixture)
})

afterEach(async () => {
  await api.close()
  await fixture.close()
})

test("create denies assignment without the Workspace work.assign grant atomically", async () => {
  // Given
  const context = await setup("public", ["work.create", "work.read", "space.read"], [])
  const before = await mutationCounts()

  // When
  const response = await createWork(context, "missing-workspace-assignment")

  // Then
  assert.equal(response.status, 404)
  assert.equal(await workCount(), 0)
  assert.deepEqual(await mutationCounts(), before)
})

test("create denies assignment without the private Space work.assign grant atomically", async () => {
  // Given
  const context = await setup(
    "private",
    ["work.create", "work.read", "work.assign", "space.read"],
    ["work.create", "work.read", "space.read"],
  )
  const before = await mutationCounts()

  // When
  const response = await createWork(context, "missing-space-assignment")

  // Then
  assert.equal(response.status, 404)
  assert.equal(await workCount(), 0)
  assert.deepEqual(await mutationCounts(), before)
})

test("owner change denies assignment excluded by a restricted Work Item atomically", async () => {
  // Given
  const context = await setup("public", ["work.read", "work.update", "work.assign"], [])
  const workId = await ownerCreatesWork(context.stateId)
  await restrictWork(workId, ["work.read", "work.update"])
  const before = await mutationCounts()

  // When
  const response = await api.sendWithToken(
    context.token,
    `/work-items/${workId}`,
    "PATCH",
    2,
    { accountableOwnerId: "actor" },
    "restricted-assignment",
  )

  // Then
  assert.equal(response.status, 404)
  assert.deepEqual(await workState(workId), { accountable_owner_id: "owner", revision: 2 })
  assert.deepEqual(await mutationCounts(), before)
})

for (const scope of ["Workspace", "private Space"] as const) {
  test(`owner change requires the ${scope} work.assign grant atomically`, async () => {
    const permissions = ["work.read", "work.update", "work.assign"] satisfies WorkPermission[]
    const withoutAssignment = permissions.filter((permission) => permission !== "work.assign")
    const context = await setup(
      "private",
      scope === "Workspace" ? withoutAssignment : permissions,
      scope === "private Space" ? withoutAssignment : permissions,
    )
    const workId = await ownerCreatesWork(context.stateId)
    const before = await mutationCounts()

    const response = await api.sendWithToken(
      context.token,
      `/work-items/${workId}`,
      "PATCH",
      1,
      { accountableOwnerId: "actor" },
      `missing-${scope.replaceAll(" ", "-")}-assignment`,
    )

    assert.equal(response.status, 404)
    assert.deepEqual(await workState(workId), { accountable_owner_id: "owner", revision: 1 })
    assert.deepEqual(await mutationCounts(), before)
  })
}

test("create permits assignment with effective Workspace and private Space grants", async () => {
  const permissions = [
    "work.create",
    "work.read",
    "work.assign",
    "space.read",
  ] satisfies WorkPermission[]
  const context = await setup("private", permissions, permissions)

  const response = await createWork(context, "effective-create-assignment")

  assert.equal(response.status, 201, JSON.stringify(response.body))
  assert.equal(await workCount(), 1)
})

test("owner change permits assignment with effective Workspace Space and entity grants", async () => {
  // Given
  const permissions = ["work.read", "work.update", "work.assign"] satisfies WorkPermission[]
  const context = await setup("private", permissions, permissions)
  const workId = await ownerCreatesWork(context.stateId)
  await restrictWork(workId, permissions)

  // When
  const response = await api.sendWithToken(
    context.token,
    `/work-items/${workId}`,
    "PATCH",
    2,
    { accountableOwnerId: "actor" },
    "effective-assignment",
  )

  // Then
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.deepEqual(await workState(workId), { accountable_owner_id: "actor", revision: 3 })
})

async function setup(
  visibility: "public" | "private",
  workspacePermissions: readonly WorkPermission[],
  spacePermissions: readonly WorkPermission[],
): Promise<{ readonly token: string; readonly stateId: string }> {
  await api.send(
    "/spaces",
    "POST",
    null,
    {
      id: "engineering",
      key: "ENG",
      name: "Engineering",
      visibility,
      description: "",
      icon: null,
      leadId: null,
    },
    "space",
  )
  const admin = new IdentityAdmin(fixture.sql)
  await admin.provisionPrincipal({
    workspaceId: "w",
    principalId: "actor",
    displayName: "Actor",
    kind: "human",
    role: "member",
    permissions: [...workspacePermissions],
  })
  const issued = await admin.issueToken({
    workspaceId: "w",
    principalId: "actor",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  if (visibility === "private") {
    const access = await api.send(
      "/spaces/engineering/access",
      "PUT",
      1,
      { principalId: "actor", permissions: spacePermissions },
      "actor-space-access",
    )
    assert.equal(access.status, 200, JSON.stringify(access.body))
  }
  const states = await fixture.sql<{ readonly id: string }[]>`
    select id from workflow_states where workspace_id='w' and space_id='engineering'
      and category='unstarted' and active`
  return { token: issued.token, stateId: required(states[0]?.id) }
}

async function createWork(
  context: { readonly token: string; readonly stateId: string },
  key: string,
) {
  return api.sendWithToken(
    context.token,
    "/work-items",
    "POST",
    null,
    workPayload(context.stateId),
    key,
  )
}

async function ownerCreatesWork(stateId: string): Promise<string> {
  const response = await api.send("/work-items", "POST", null, workPayload(stateId), "owner-work")
  assert.equal(response.status, 201, JSON.stringify(response.body))
  return resultId(response.body)
}

function workPayload(stateId: string) {
  return {
    spaceId: "engineering",
    title: "Assignment target",
    accountableOwnerId: "owner",
    description: "",
    type: "Task",
    workflowStateId: stateId,
    projectId: null,
    priority: "medium",
    labelIds: [],
    startDate: null,
    dueDate: null,
  }
}

async function restrictWork(workId: string, actorPermissions: readonly WorkPermission[]) {
  const response = await api.send(
    `/entities/${workId}/access`,
    "PUT",
    1,
    {
      mode: "restricted",
      allowances: [
        {
          principalId: "owner",
          permissions: ["work.read", "work.update", "work.assign", "acl.manage"],
        },
        { principalId: "actor", permissions: actorPermissions },
      ],
    },
    `restrict-${actorPermissions.join("-")}`,
  )
  assert.equal(response.status, 200, JSON.stringify(response.body))
}

async function workCount(): Promise<number> {
  const rows = await fixture.sql<{ readonly count: number }[]>`
    select count(*)::integer count from work_items`
  return required(rows[0]).count
}

async function mutationCounts() {
  const [counts] = await fixture.sql`select
    (select count(*)::integer from work_item_revisions) legacy_revisions,
    (select count(*)::integer from entity_revisions) revisions,
    (select count(*)::integer from domain_events) legacy_events,
    (select count(*)::integer from entity_events_v1) events,
    (select count(*)::integer from outbox_events) legacy_outbox,
    (select count(*)::integer from entity_outbox_events_v1) outbox,
    (select count(*)::integer from generic_command_idempotency) idempotency`
  return required(counts)
}

async function workState(workId: string): Promise<Readonly<Record<string, unknown>>> {
  const rows = await fixture.sql`select accountable_owner_id,revision::integer revision
    from work_items where id=${workId}`
  return required(rows[0])
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("required fixture value is missing")
  return value
}
