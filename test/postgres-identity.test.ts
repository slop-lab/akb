import assert from "node:assert/strict"
import { after, beforeEach, test } from "node:test"
import { IdentityAdmin, RuntimeCredentialRejectedError } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { createPostgresTestFixture } from "./postgres-fixture.ts"

const database = await createPostgresTestFixture()
const admin = new IdentityAdmin(database.sql)
after(database.close)
beforeEach(database.reset)

test("bootstrap stores only a SHA-256 token hash and authenticates the printed token", async () => {
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "workspace-one",
    workspaceName: "Workspace One",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })

  const rows = await database.sql<{ readonly token_hash: Buffer; readonly raw_present: boolean }[]>`
    select token_hash, encode(token_hash, 'escape') like '%afw_%' as raw_present
    from principal_credentials where id = ${issued.credentialId}
  `
  const principal = await authenticateToken(database.sql, issued.token)

  assert.equal(issued.token.startsWith("afw_"), true)
  assert.equal(rows[0]?.token_hash.length, 32)
  assert.equal(rows[0]?.raw_present, false)
  assert.equal(principal?.principalId, "human-one")
})

test("expired, revoked, disabled, and deactivated identities fail identically", async () => {
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "workspace-one",
    workspaceName: "Workspace One",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await admin.revokeToken({ credentialId: issued.credentialId })
  assert.equal(await authenticateToken(database.sql, issued.token), undefined)

  const active = await admin.issueToken({
    workspaceId: "workspace-one",
    principalId: "human-one",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await database.sql`update principals set status = 'disabled' where id = 'human-one'`
  assert.equal(await authenticateToken(database.sql, active.token), undefined)
  await database.sql`update principals set status = 'active' where id = 'human-one'`
  await database.sql`update workspace_memberships set status = 'deactivated'
    where principal_id = 'human-one'`
  assert.equal(await authenticateToken(database.sql, active.token), undefined)
  await database.sql`update workspace_memberships set status = 'active'
    where principal_id = 'human-one'`
  await database.sql`update workspaces set status = 'archived' where id = 'workspace-one'`
  assert.equal(await authenticateToken(database.sql, active.token), undefined)
  assert.equal(await authenticateToken(database.sql, "afw_invalid"), undefined)
})

test("authentication rejects a credential expired by the database clock", async () => {
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "workspace-one",
    workspaceName: "Workspace One",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await database.sql`update principal_credentials set expires_at = clock_timestamp() - interval '1 second'
    where id = ${issued.credentialId}`

  assert.equal(await authenticateToken(database.sql, issued.token), undefined)
})

test("runtime principals cannot receive general bearer credentials", async () => {
  await admin.bootstrapWorkspace({
    workspaceId: "workspace-one",
    workspaceName: "Workspace One",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await admin.provisionPrincipal({
    workspaceId: "workspace-one",
    principalId: "runtime-one",
    displayName: "Runtime One",
    kind: "runtime",
    role: "member",
    permissions: [],
  })

  await assert.rejects(
    admin.issueToken({
      workspaceId: "workspace-one",
      principalId: "runtime-one",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }),
    RuntimeCredentialRejectedError,
  )
})

test("human, agent, and service credentials retain only explicitly assigned grants", async () => {
  await admin.bootstrapWorkspace({
    workspaceId: "workspace-one",
    workspaceName: "Workspace One",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  for (const kind of ["agent", "service"] as const) {
    await admin.provisionPrincipal({
      workspaceId: "workspace-one",
      principalId: `${kind}-one`,
      displayName: `${kind} one`,
      kind,
      role: "member",
      permissions: ["work.read"],
    })
    const issued = await admin.issueToken({
      workspaceId: "workspace-one",
      principalId: `${kind}-one`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    })
    assert.equal((await authenticateToken(database.sql, issued.token))?.principalId, `${kind}-one`)
  }
  const grants = await database.sql<
    { readonly principal_id: string; readonly permission: string }[]
  >`
    select principal_id, permission from membership_permissions
    where principal_id in ('agent-one', 'service-one') order by principal_id, permission`
  assert.deepEqual(
    [...grants],
    [
      { principal_id: "agent-one", permission: "work.read" },
      { principal_id: "service-one", permission: "work.read" },
    ],
  )
})

test("administrator rejects expired issuance, inactive authority, and missing permission targets", async () => {
  await admin.bootstrapWorkspace({
    workspaceId: "workspace-one",
    workspaceName: "Workspace One",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })

  await assert.rejects(
    admin.issueToken({
      workspaceId: "workspace-one",
      principalId: "human-one",
      expiresAt: "2020-01-01T00:00:00.000Z",
    }),
    { name: "CredentialExpiryError" },
  )
  await assert.rejects(
    admin.setPermissions({
      workspaceId: "workspace-one",
      principalId: "missing",
      permissions: [],
    }),
    { name: "IdentityNotActiveError" },
  )
  await database.sql`update workspaces set status = 'archived' where id = 'workspace-one'`
  await assert.rejects(
    admin.issueToken({
      workspaceId: "workspace-one",
      principalId: "human-one",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }),
    { name: "IdentityNotActiveError" },
  )
})

test("revocation remains available for disabled and deactivated identities", async () => {
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "workspace-one",
    workspaceName: "Workspace One",
    principalId: "human-one",
    principalName: "Human One",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await database.sql`update principals set status = 'disabled' where id = 'human-one'`
  await database.sql`update workspace_memberships set status = 'deactivated'
    where workspace_id = 'workspace-one' and principal_id = 'human-one'`

  await admin.revokeToken({ credentialId: issued.credentialId })

  const rows = await database.sql<{ readonly revoked: boolean }[]>`
    select revoked_at is not null as revoked from principal_credentials where id = ${issued.credentialId}`
  assert.equal(rows[0]?.revoked, true)
})

test("identity IDs share codepoint-aware normalization with Work Item identifiers", async () => {
  const emojiId = "😀".repeat(65)

  const issued = await admin.bootstrapWorkspace({
    workspaceId: `  ${emojiId}  `,
    workspaceName: "Unicode Workspace",
    principalId: `  ${emojiId}  `,
    principalName: "Unicode Principal",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(database.sql, issued.token)

  assert.equal(principal?.workspaceId, emojiId)
  assert.equal(principal?.principalId, emojiId)
})
