import { randomBytes } from "node:crypto"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import type { AuthenticatedPrincipal } from "../src/identity/types.ts"
import { R4CommandService } from "../src/pm/commands/service.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

export type SearchFixture = {
  readonly database: UnmigratedPostgresTestFixture
  readonly owner: AuthenticatedPrincipal
  readonly ownerToken: string
  readonly viewer: AuthenticatedPrincipal
  readonly signingKey: Uint8Array
  readonly commands: R4CommandService
  readonly execute: (
    action: "space.create" | "work-item.create" | "work-item.update" | "comment.create",
    parentId: string | null,
    resourceId: string | null,
    baseRevision: number | null,
    payload: unknown,
  ) => Promise<string>
  readonly createWork: (
    spaceId: string,
    stateId: string,
    title: string,
    key: string,
  ) => Promise<string>
}

export async function createSearchFixture(): Promise<SearchFixture> {
  const database = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(database.sql)
  const admin = new IdentityAdmin(database.sql)
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "search",
    workspaceName: "Search",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const owner = requiredPrincipal(await authenticateToken(database.sql, issued.token))
  await admin.provisionPrincipal({
    workspaceId: "search",
    principalId: "viewer",
    displayName: "Viewer",
    kind: "human",
    role: "member",
    permissions: ["work.read", "project.read"],
  })
  const viewerCredential = await admin.issueToken({
    workspaceId: "search",
    principalId: "viewer",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const viewer = requiredPrincipal(await authenticateToken(database.sql, viewerCredential.token))
  const commands = new R4CommandService(database.sql)
  let sequence = 0
  const execute: SearchFixture["execute"] = async (
    action,
    parentId,
    resourceId,
    baseRevision,
    payload,
  ) => {
    sequence += 1
    const key = `${action}-${sequence}`
    const result = await commands.execute({
      workspaceId: "search",
      principal: owner,
      commandId: key,
      idempotencyKey: key,
      baseRevision,
      action,
      route: action,
      resourceId,
      parentId,
      payload,
    })
    const id = Reflect.get(result.result, "id")
    if (typeof id !== "string") throw new TypeError("command did not return an entity ID")
    return id
  }
  const createWork: SearchFixture["createWork"] = async (spaceId, stateId, title, key) =>
    execute("work-item.create", null, null, null, {
      spaceId,
      title,
      accountableOwnerId: "owner",
      description: key,
      type: "Task",
      workflowStateId: stateId,
      projectId: null,
      priority: "none",
      labelIds: [],
      startDate: null,
      dueDate: null,
    })
  return {
    database,
    owner,
    ownerToken: issued.token,
    viewer,
    signingKey: randomBytes(32),
    commands,
    execute,
    createWork,
  }
}

export async function seedSecuritySearch(fixture: SearchFixture): Promise<void> {
  await fixture.execute("space.create", null, null, null, {
    id: "public",
    key: "PUB",
    name: "Public",
    visibility: "public",
    description: "",
    icon: null,
    leadId: null,
  })
  await fixture.execute("space.create", null, null, null, {
    id: "private",
    key: "PVT",
    name: "Private",
    visibility: "private",
    description: "",
    icon: null,
    leadId: null,
  })
  const states = await fixture.database.sql<
    { readonly id: string; readonly space_id: string }[]
  >`select id,space_id from workflow_states where workspace_id='search' and is_default`
  const publicState = requiredState(states, "public")
  const privateState = requiredState(states, "private")
  await fixture.createWork("public", publicState, "Visible searchable", "visible")
  const restricted = await fixture.createWork("public", publicState, "Second searchable", "second")
  await fixture.createWork("private", privateState, "Privateonly searchable", "private")
  const comment = await fixture.execute("comment.create", restricted, null, null, {
    body: "Commentonly",
  })
  await fixture.database
    .sql`update entity_acl_policies set mode='restricted' where entity_id=${restricted}`
  await fixture.database.sql`insert into entity_acl_allowances(entity_id,principal_id,permission)
    values (${restricted},'owner','work.read')`
  await fixture.database
    .sql`update entity_acl_policies set mode='restricted' where entity_id=${comment}`
  await fixture.database
    .sql`insert into entity_acl_allowances(entity_id,principal_id,permission) values
    (${comment},'owner','work.read'),(${comment},'viewer','work.read')`
}

function requiredPrincipal(value: AuthenticatedPrincipal | undefined): AuthenticatedPrincipal {
  if (value === undefined) throw new TypeError("fixture authentication failed")
  return value
}

function requiredState(
  rows: readonly { readonly id: string; readonly space_id: string }[],
  spaceId: string,
): string {
  const id = rows.find((row) => row.space_id === spaceId)?.id
  if (id === undefined) throw new TypeError("fixture default state missing")
  return id
}
