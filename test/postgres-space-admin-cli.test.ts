import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { z } from "zod"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { runAdminCli } from "../src/identity/admin-cli.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
const identity = new IdentityAdmin(database.sql)
after(database.close)
beforeEach(database.reset)

test("administrator CLI persists Space visibility and grant projections", async () => {
  await identity.bootstrapWorkspace({
    workspaceId: "workspace",
    workspaceName: "Workspace",
    principalId: "admin",
    principalName: "Admin",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const schemaRows = await database.sql<
    { readonly schema: string }[]
  >`select current_schema() as schema`
  const schema = z.string().parse(schemaRows[0]?.schema)
  const { DATABASE_URL: databaseUrl } = process.env
  const url = new URL(z.string().url().parse(databaseUrl))
  url.searchParams.set("options", `-csearch_path=${schema}`)
  const environment = { DATABASE_URL: url.toString() }

  const created = await runAdminCli(
    [
      "create-space",
      "--workspace-id",
      "workspace",
      "--space-id",
      "cli-space",
      "--space-name",
      "CLI Space",
      "--visibility",
      "public",
    ],
    environment,
  )
  await runAdminCli(
    [
      "set-space-visibility",
      "--workspace-id",
      "workspace",
      "--space-id",
      "cli-space",
      "--visibility",
      "private",
    ],
    environment,
  )
  const granted = await runAdminCli(
    [
      "set-space-permissions",
      "--workspace-id",
      "workspace",
      "--space-id",
      "cli-space",
      "--principal-id",
      "admin",
      "--permissions",
      "work.read,work.update",
    ],
    environment,
  )
  const projection = await database.sql`
    select s.visibility, array_agg(p.permission order by p.permission) as permissions
    from spaces s join space_permissions p on p.workspace_id = s.workspace_id and p.space_id = s.id
    where s.workspace_id = 'workspace' and s.id = 'cli-space' group by s.visibility`

  assert.deepEqual(JSON.parse(created), { created: "cli-space" })
  assert.deepEqual(JSON.parse(granted), { updated: "cli-space", principalId: "admin" })
  assert.deepEqual(
    [...projection],
    [{ visibility: "private", permissions: ["work.read", "work.update"] }],
  )
})

test("administrator CLI configures feature permissions at Workspace Space and entity scopes", async () => {
  // Given
  await identity.bootstrapWorkspace({
    workspaceId: "features",
    workspaceName: "Features",
    principalId: "operator",
    principalName: "Operator",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const rows = await database.sql<{ readonly schema: string }[]>`select current_schema() schema`
  const url = new URL(z.string().parse(process.env["DATABASE_URL"]))
  url.searchParams.set("options", `-csearch_path=${z.string().parse(rows[0]?.schema)}`)
  const environment = { DATABASE_URL: url.toString() }
  const target = ["--workspace-id", "features", "--principal-id", "operator"]
  await runAdminCli(
    [
      "create-space",
      "--workspace-id",
      "features",
      "--space-id",
      "private",
      "--space-name",
      "Private",
      "--visibility",
      "private",
    ],
    environment,
  )
  const entities = await database.sql<{ readonly id: string }[]>`
    select stable_space_entity_id('features','private') id`

  // When
  await runAdminCli(
    ["set-permissions", ...target, "--permissions", "content.read,content.manage,run.delegate"],
    environment,
  )
  await runAdminCli(
    [
      "set-space-permissions",
      ...target,
      "--space-id",
      "private",
      "--permissions",
      "content.read,content.manage",
    ],
    environment,
  )
  await runAdminCli(
    [
      "set-entity-access",
      ...target,
      "--entity-id",
      z.string().parse(entities[0]?.id),
      "--mode",
      "restricted",
      "--permissions",
      "content.read,content.manage",
    ],
    environment,
  )

  // Then
  const access = await database.sql<{ readonly allowed: boolean }[]>`
    select entity_access_allowed('features',stable_space_entity_id('features','private'),
      'operator','content.manage') allowed`
  assert.equal(access[0]?.allowed, true)
  const grants = await database.sql<{ readonly permission: string }[]>`
    select permission from membership_permissions where workspace_id='features'
      and principal_id='operator' order by permission`
  assert.deepEqual(
    grants.map((row) => row.permission),
    ["content.manage", "content.read", "run.delegate"],
  )
})
