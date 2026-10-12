import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { createEntityEventRouter } from "../src/http/entity-event-router.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import type { WorkPermission } from "../src/identity/types.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

test("generic replay classifies labels as space.read and retains whole-workspace gating", async () => {
  const database = await createPostgresTestFixture()
  const identity = new IdentityAdmin(database.sql)
  await identity.bootstrapWorkspace({
    workspaceId: "w",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00Z",
  })
  const permissions = ["space.read", "work.read"] satisfies WorkPermission[]
  const workReader = await issue(identity, "work-reader", permissions)
  const spaceReader = await issue(identity, "space-reader", permissions)
  await database.sql`insert into entities
    (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    values ('label:visible','w','label',1,'owner',clock_timestamp(),clock_timestamp())`
  await database.sql`insert into entity_acl_policies values ('label:visible','restricted')`
  await database.sql`insert into entity_acl_allowances (entity_id,principal_id,permission) values
    ('label:visible','space-reader','space.read'),('label:visible','work-reader','work.read')`
  await database.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    values ('label:visible',1,'label.r4.v1',${database.sql.json({ id: "label:visible" })},'owner',clock_timestamp(),repeat('0',64))`
  await database.sql`insert into entity_events_v1
    (id,workspace_id,sequence,event_type,subject_kind,subject_id,subject_revision,occurred_at,actor_id,data)
    values ('event-label','w',1,'entity.created','label','label:visible',1,clock_timestamp(),'owner',${database.sql.json({ id: "label:visible" })})`
  const server = createAuthenticatedPostgresServer(
    database.sql,
    {
      newWorkItemId: () => workItemId(randomUUID()),
      newEventId: () => eventId(randomUUID()),
      now: () => new Date().toISOString(),
    },
    [createEntityEventRouter(database.sql)],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("missing address")
  const url = `http://127.0.0.1:${(address satisfies AddressInfo).port}/api/events/v1/workspaces/w/events?after=0&limit=10`

  try {
    await assertPermissionDenied(await replay(url, workReader.token))
    const allowed = await replay(url, spaceReader.token)
    assert.equal(allowed.status, 200)
    assert.match(JSON.stringify(await allowed.json()), /label:visible/)
    await database.sql`insert into entities
      (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
      values ('work:hidden','w','work_item',1,'owner',clock_timestamp(),clock_timestamp())`
    await database.sql`insert into entity_acl_policies values ('work:hidden','restricted')`
    await assertPermissionDenied(await replay(url, spaceReader.token))
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
    await database.close()
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

function replay(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { authorization: `Bearer ${token}` } })
}

async function assertPermissionDenied(response: Response): Promise<void> {
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), {
    error: {
      code: "permission_denied",
      message: "permission denied",
      retryable: false,
      details: {},
    },
  })
}
