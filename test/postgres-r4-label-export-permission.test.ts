import assert from "node:assert/strict"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { createR4ExportRouter } from "../src/http/human-v1/export-router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import type { WorkPermission } from "../src/identity/types.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createUnmigratedPostgresTestFixture } from "./postgres-fixture.ts"

test("label export requires space.read rather than work.read", async () => {
  const fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  const identity = new IdentityAdmin(fixture.sql)
  await identity.bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await new SpaceAdmin(fixture.sql).create({
    workspaceId: "w",
    spaceId: "space",
    spaceName: "Space",
    visibility: "public",
  })
  await fixture.sql`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    values ('label','w','label','space',1,'owner',clock_timestamp(),clock_timestamp())`
  await fixture.sql`insert into entity_acl_policies values ('label','restricted')`
  await fixture.sql`insert into labels (id,workspace_id,space_id,name,color,revision)
    values ('label','w','space','Visible label','blue',1)`
  const permissions = ["space.read", "work.read"] satisfies WorkPermission[]
  const spaceReader = await issue(identity, "space-reader", permissions)
  const workReader = await issue(identity, "work-reader", permissions)
  await fixture.sql`insert into entity_acl_allowances (entity_id,principal_id,permission) values
    ('label','space-reader','space.read'),('label','work-reader','work.read')`
  const server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-12T00:00:00.000Z",
    },
    [createR4ExportRouter(fixture.sql)],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("missing address")
  const endpoint = `http://127.0.0.1:${(address satisfies AddressInfo).port}/api/human/v1/workspaces/w/export`

  try {
    const allowed = await requestExport(endpoint, spaceReader.token)
    const denied = await requestExport(endpoint, workReader.token)
    assert.equal(allowed.status, 200)
    assert.match(await allowed.text(), /"kind":"label"/)
    assert.equal(denied.status, 200)
    assert.doesNotMatch(await denied.text(), /"kind":"label"/)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
    await fixture.close()
  }
})

async function issue(
  identity: IdentityAdmin,
  principalId: string,
  permissions: readonly WorkPermission[],
) {
  await identity.provisionPrincipal({
    workspaceId: "w",
    principalId,
    displayName: principalId,
    kind: "human",
    role: "member",
    permissions: [...permissions],
  })
  return identity.issueToken({ workspaceId: "w", principalId, expiresAt: "2030-01-01T00:00:00Z" })
}

function requestExport(endpoint: string, token: string): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ includeArchived: true, spaceId: "space" }),
  })
}
