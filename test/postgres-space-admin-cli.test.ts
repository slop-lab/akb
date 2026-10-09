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
