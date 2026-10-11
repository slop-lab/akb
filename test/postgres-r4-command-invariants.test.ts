import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { WORK_PERMISSIONS } from "../src/identity/types.ts"
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

test("partial dates ACL scopes and workflow use fail atomically", async () => {
  // Given
  const admin = new IdentityAdmin(fixture.sql)
  await admin.provisionPrincipal({
    workspaceId: "w",
    principalId: "member",
    displayName: "Member",
    kind: "human",
    role: "member",
    permissions: [...WORK_PERMISSIONS],
  })
  const member = await admin.issueToken({
    workspaceId: "w",
    principalId: "member",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await api.send(
    "/spaces",
    "POST",
    null,
    {
      id: "engineering",
      key: "ENG",
      name: "Engineering",
      visibility: "private",
      description: "",
      icon: null,
      leadId: null,
    },
    "space",
  )
  await api.send(
    "/spaces/engineering/access",
    "PUT",
    1,
    { principalId: "member", permissions: WORK_PERMISSIONS },
    "member-space",
  )
  const states = await fixture.sql<{ readonly id: string }[]>`
    select id from workflow_states where workspace_id='w' and space_id='engineering'
      and category='unstarted' and active`
  const stateId = required(states[0]?.id)
  const project = await api.send(
    "/projects",
    "POST",
    null,
    {
      name: "Launch",
      slug: "launch",
      summary: "",
      ownerId: "member",
      leadIds: ["member"],
      participatingSpaceIds: ["engineering"],
      state: "active",
      health: "on_track",
      priority: "high",
      startDate: "2026-01-01",
      targetDate: "2026-02-01",
    },
    "project",
  )
  const projectId = resultId(project.body)
  const work = await api.send(
    "/work-items",
    "POST",
    null,
    {
      spaceId: "engineering",
      title: "Ship",
      accountableOwnerId: "member",
      description: "",
      type: "Task",
      workflowStateId: stateId,
      projectId,
      priority: "high",
      labelIds: [],
      startDate: "2026-01-01",
      dueDate: "2026-01-31",
    },
    "work",
  )
  const workId = resultId(work.body)

  // When
  const projectDate = await api.send(
    `/projects/${projectId}`,
    "PATCH",
    1,
    { startDate: "2026-03-01" },
    "project-date",
  )
  const workDate = await api.send(
    `/work-items/${workId}`,
    "PATCH",
    1,
    { dueDate: "2025-12-31" },
    "work-date",
  )
  const spaceLock = await api.send(
    "/spaces/engineering/access",
    "PUT",
    2,
    { principalId: "owner", permissions: ["space.read"] },
    "space-lock",
  )
  const entityLock = await api.send(
    `/entities/${projectId}/access`,
    "PUT",
    1,
    {
      mode: "restricted",
      allowances: [{ principalId: "owner", permissions: ["project.read"] }],
    },
    "entity-lock",
  )
  const usedState = await api.send(
    `/spaces/engineering/workflow/states/${stateId}/archive`,
    "POST",
    1,
    {},
    "used-state",
  )
  const restrictProject = await api.send(
    `/entities/${projectId}/access`,
    "PUT",
    1,
    {
      mode: "restricted",
      allowances: [
        { principalId: "owner", permissions: ["project.read", "project.manage", "acl.manage"] },
      ],
    },
    "restrict-project",
  )
  const replayProjectAccess = await api.send(
    `/entities/${projectId}/access`,
    "PUT",
    1,
    {
      mode: "restricted",
      allowances: [
        { principalId: "owner", permissions: ["project.read", "project.manage", "acl.manage"] },
      ],
    },
    "restrict-project",
  )
  const updateProjectAfterAccess = await api.send(
    `/projects/${projectId}`,
    "PATCH",
    2,
    { summary: "ACL preserved the project" },
    "project-after-access",
  )
  const hiddenRelation = await api.sendWithToken(
    member.token,
    "/relations",
    "POST",
    null,
    { fromEntityId: projectId, relationType: "supports", toEntityId: workId },
    "hidden-relation",
  )
  const restrictWork = await api.send(
    `/entities/${workId}/access`,
    "PUT",
    1,
    {
      mode: "restricted",
      allowances: [
        { principalId: "owner", permissions: ["work.read", "work.update", "acl.manage"] },
      ],
    },
    "restrict-work",
  )
  const hiddenComment = await api.sendWithToken(
    member.token,
    `/entities/${workId}/comments`,
    "POST",
    null,
    { body: "hidden" },
    "hidden-comment",
  )

  // Then
  assert.deepEqual(
    [
      projectDate.status,
      workDate.status,
      spaceLock.status,
      entityLock.status,
      usedState.status,
      restrictProject.status,
      replayProjectAccess.status,
      updateProjectAfterAccess.status,
      hiddenRelation.status,
      restrictWork.status,
      hiddenComment.status,
    ],
    [409, 409, 409, 409, 409, 200, 200, 200, 404, 200, 404],
  )
  const state = await fixture.sql`select
    (select current_revision::integer from entities where id=${projectId}) project_revision,
    (select current_revision::integer from entities where id=${workId}) work_revision,
    (select revision::integer from projects where id=${projectId}) project_row_revision,
    (select schema_version from entity_revisions where entity_id=${projectId} and revision=2)
      project_access_schema,
    (select canonical_snapshot->>'name' from entity_revisions
      where entity_id=${projectId} and revision=2) project_access_name,
    (select start_date::text from projects where id=${projectId}) project_start,
    (select due_date::text from work_item_pm where work_item_id=${workId}) work_due,
    (select count(*)::integer from relations) relations,
    (select count(*)::integer from comments) comments`
  assert.deepEqual(
    [...state],
    [
      {
        project_revision: 3,
        work_revision: 2,
        project_row_revision: 3,
        project_access_schema: "project.r4.v1",
        project_access_name: "Launch",
        project_start: "2026-01-01",
        work_due: "2026-01-31",
        relations: 0,
        comments: 0,
      },
    ],
  )
})

test("missing entity ACL policy denies access and parent invariants reject cycles", async () => {
  // Given
  await api.send(
    "/spaces",
    "POST",
    null,
    {
      id: "engineering",
      key: "ENG",
      name: "Engineering",
      visibility: "public",
      description: "",
      icon: null,
      leadId: null,
    },
    "space",
  )
  const labels = await Promise.all(
    ["A", "B", "C"].map(async (name) => {
      const response = await api.send(
        "/spaces/engineering/labels",
        "POST",
        null,
        { name, color: "blue" },
        `label-${name}`,
      )
      return resultId(response.body)
    }),
  )
  const first = required(labels[0])
  const second = required(labels[1])
  const third = required(labels[2])
  const parent = await api.send(
    "/relations",
    "POST",
    null,
    { fromEntityId: first, relationType: "parent_of", toEntityId: second },
    "parent",
  )

  // When
  const duplicateParent = await api.send(
    "/relations",
    "POST",
    null,
    { fromEntityId: third, relationType: "parent_of", toEntityId: second },
    "duplicate-parent",
  )
  const cycle = await api.send(
    "/relations",
    "POST",
    null,
    { fromEntityId: second, relationType: "parent_of", toEntityId: first },
    "cycle",
  )
  await fixture.sql`delete from entity_acl_policies where entity_id=${third}`
  const access = await fixture.sql<{ readonly allowed: boolean }[]>`
    select entity_access_allowed('w',${third},'owner','space.manage') allowed`

  // Then
  assert.equal(parent.status, 201)
  assert.equal(duplicateParent.status, 409)
  assert.equal(cycle.status, 409)
  assert.deepEqual([...access], [{ allowed: false }])
  const counts = await fixture.sql`select count(*)::integer count from relations`
  assert.deepEqual([...counts], [{ count: 1 }])
})

function required(value: string | undefined): string {
  if (value === undefined) throw new TypeError("fixture value is missing")
  return value
}
