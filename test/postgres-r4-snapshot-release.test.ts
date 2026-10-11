import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import type { Server } from "node:http"
import { afterEach, beforeEach, test } from "node:test"
import { createR4HumanRouter } from "../src/http/human-v1/human-router.ts"
import { BoardService } from "../src/human-query/board-service.ts"
import { ProjectQueryService } from "../src/human-query/project-query-service.ts"
import { HumanReadService } from "../src/human-query/read-service.ts"
import { HumanQueryService } from "../src/human-query/service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import {
  AuthenticationRequiredError,
  WorkspaceNotFoundError,
} from "../src/identity/authorization-errors.ts"
import type { AuthenticatedPrincipal } from "../src/identity/types.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { createPostgresSearch } from "../src/search/postgres-search.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let server: Server | undefined

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
})

afterEach(async () => {
  if (server?.listening === true) {
    await new Promise<void>((resolve, reject) =>
      server?.close((error?: Error) => (error === undefined ? resolve() : reject(error))),
    )
  }
  await fixture.close()
})

test("release removes an owned snapshot after read loss and restores the snapshot budget", async () => {
  // Given
  const { admin, owner } = await identities()
  await fixture.sql`insert into entities
    (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    values ('snapshot-member','release','project',1,'owner',clock_timestamp(),clock_timestamp())`
  const ids = Array.from({ length: 8 }, () => randomUUID())
  for (const id of ids) await insertSnapshot(owner, id)
  const releasedId = ids[0]
  if (releasedId === undefined) throw new TypeError("release snapshot fixture missing")
  await fixture.sql`insert into human_query_snapshot_items
    (snapshot_id,ordinal,entity_id,source_revision) values (${releasedId}::uuid,1,'snapshot-member',1)`
  await assert.rejects(insertSnapshot(owner, randomUUID()), /at most eight active snapshots/)
  await admin.setPermissions({ workspaceId: "release", principalId: "owner", permissions: [] })

  // When
  await new HumanReadService(fixture.sql).releaseSnapshot(owner, "release", releasedId)

  // Then
  assert.equal(await snapshotCount(), 7)
  assert.equal(await snapshotItemCount(), 0)
  await insertSnapshot(owner, randomUUID())
  assert.equal(await snapshotCount(), 8)
})

test("release leaves absent and foreign principal or credential snapshots untouched", async () => {
  // Given
  const { owner, ownerSecond, other } = await identities()
  const ownerId = randomUUID()
  const secondCredentialId = randomUUID()
  const otherId = randomUUID()
  await insertSnapshot(owner, ownerId)
  await insertSnapshot(ownerSecond, secondCredentialId)
  await insertSnapshot(other, otherId)
  const service = new HumanReadService(fixture.sql)

  // When
  await Promise.all([
    service.releaseSnapshot(owner, "release", randomUUID()),
    service.releaseSnapshot(owner, "release", secondCredentialId),
    service.releaseSnapshot(owner, "release", otherId),
  ])

  // Then
  assert.equal(await snapshotCount(), 3)
})

test("release rejects a stale credential and a foreign workspace namespace", async () => {
  // Given
  const { admin, issued, owner } = await identities()
  const service = new HumanReadService(fixture.sql)
  await admin.revokeToken({ credentialId: issued.credentialId })

  // When / Then
  await assert.rejects(
    service.releaseSnapshot(owner, "release", randomUUID()),
    AuthenticationRequiredError,
  )
  const active = await authenticateToken(
    fixture.sql,
    (
      await admin.issueToken({
        workspaceId: "release",
        principalId: "owner",
        expiresAt: "2030-01-01T00:00:00.000Z",
      })
    ).token,
  )
  if (active === undefined) throw new TypeError("replacement authentication failed")
  await assert.rejects(
    service.releaseSnapshot(active, "other", randomUUID()),
    WorkspaceNotFoundError,
  )
})

test("HTTP release handles every query snapshot kind without revealing foreign ownership", async () => {
  // Given
  const { admin, issued, owner, ownerSecond, other } = await identities()
  const secondCredentialId = randomUUID()
  const otherId = randomUUID()
  const signingKey = randomBytes(32)
  const work = await new HumanQueryService(fixture.sql, signingKey).queryWorkItems(
    owner,
    "release",
    {
      model: "r4",
      filter: null,
      search: null,
      sort: [{ field: "createdAt", direction: "asc" }],
      includeArchived: false,
      page: { size: 100, cursor: null },
    },
  )
  const project = await new ProjectQueryService(fixture.sql, signingKey).queryProjects(
    owner,
    "release",
    {
      filter: null,
      search: null,
      sort: [{ field: "createdAt", direction: "asc" }],
      includeArchived: false,
      page: { size: 100, cursor: null },
    },
  )
  const board = await new BoardService(fixture.sql, signingKey).query(owner, "release", {
    model: "r4",
    filter: null,
    search: null,
    sort: [{ field: "createdAt", direction: "asc" }],
    includeArchived: false,
    workflowStateId: null,
    page: { size: 25, cursor: null },
  })
  const search = await createPostgresSearch(fixture.sql, signingKey).search(owner, "release", {
    text: "missing",
    kinds: ["work_item"],
    limit: 100,
    cursor: null,
  })
  const ownIds = [work.snapshot.id, project.snapshot.id, board.snapshot.id, search.snapshot.id]
  const replayId = ownIds[0]
  if (replayId === undefined) throw new TypeError("query snapshot fixture missing")
  await insertSnapshot(ownerSecond, secondCredentialId)
  await insertSnapshot(other, otherId)
  server = createAuthenticatedPostgresServer(
    fixture.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-11T00:00:00.000Z",
    },
    [createR4HumanRouter(fixture.sql, signingKey)],
  )
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("HTTP address missing")
  const origin = `http://127.0.0.1:${address.port}`
  const release = (workspace: string, id: string, token = issued.token) =>
    fetch(`${origin}/api/human/v1/workspaces/${workspace}/query-snapshots/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    })

  // When
  const malformed = await release("release", "not-a-uuid")
  const own = await Promise.all(ownIds.map((id) => release("release", id)))
  const replay = await release("release", replayId)
  const secondCredential = await release("release", secondCredentialId)
  const anotherActor = await release("release", otherId)
  const crossWorkspace = await release("other", randomUUID())
  await admin.revokeToken({ credentialId: issued.credentialId })
  const revoked = await release("release", randomUUID())

  // Then
  assert.equal(malformed.status, 400)
  assert.deepEqual(
    [
      ...own.map((response) => response.status),
      replay.status,
      secondCredential.status,
      anotherActor.status,
    ],
    [204, 204, 204, 204, 204, 204, 204],
  )
  assert.equal(await own[0]?.text(), "")
  assert.equal(crossWorkspace.status, 404)
  assert.equal(revoked.status, 401)
  assert.equal(await snapshotCount(), 2)
})

async function identities() {
  const admin = new IdentityAdmin(fixture.sql)
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "release",
    workspaceName: "Release",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await admin.provisionPrincipal({
    workspaceId: "release",
    principalId: "other",
    displayName: "Other",
    kind: "human",
    role: "member",
    permissions: [],
  })
  const second = await admin.issueToken({
    workspaceId: "release",
    principalId: "owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const otherIssued = await admin.issueToken({
    workspaceId: "release",
    principalId: "other",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const owner = await authenticateToken(fixture.sql, issued.token)
  const ownerSecond = await authenticateToken(fixture.sql, second.token)
  const other = await authenticateToken(fixture.sql, otherIssued.token)
  if (owner === undefined || ownerSecond === undefined || other === undefined) {
    throw new TypeError("fixture authentication failed")
  }
  return { admin, issued, owner, ownerSecond, other }
}

async function insertSnapshot(principal: AuthenticatedPrincipal, id: string): Promise<void> {
  const hash = "a".repeat(64)
  await fixture.sql`insert into human_query_snapshots
    (id,workspace_id,principal_id,credential_id,query_hash,sort_hash,authority_hash,matched,expires_at)
    values (${id}::uuid,${principal.workspaceId},${principal.principalId},${principal.credentialId},
      ${hash},${hash},${hash},1,clock_timestamp()+interval '10 minutes')`
}

async function snapshotCount(): Promise<number> {
  const rows = await fixture.sql<{ readonly count: number }[]>`
    select count(*)::integer count from human_query_snapshots`
  return rows[0]?.count ?? 0
}

async function snapshotItemCount(): Promise<number> {
  const rows = await fixture.sql<{ readonly count: number }[]>`
    select count(*)::integer count from human_query_snapshot_items`
  return rows[0]?.count ?? 0
}
