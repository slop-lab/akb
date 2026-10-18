import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { CommandUnitOfWork } from "../src/entities/command-unit-of-work.ts"
import { EntityNotFoundError } from "../src/entities/errors.ts"
import type { MutationRecord } from "../src/entities/mutation-types.ts"
import { insertEntity } from "../src/entities/registry.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import type { AuthenticatedPrincipal } from "../src/identity/types.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

let fixture: UnmigratedPostgresTestFixture
let principal: AuthenticatedPrincipal

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  const issued = await new IdentityAdmin(fixture.sql).bootstrapWorkspace({
    workspaceId: "workspace",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const authenticated = await authenticateToken(fixture.sql, issued.token)
  if (authenticated === undefined) throw new TypeError("fixture authentication failed")
  principal = authenticated
  await seedEntity("alpha")
  await seedEntity("beta")
})

afterEach(async () => {
  await fixture.close()
})

test("batch command appends one revision and event per sorted locked target", async () => {
  // Given
  const unit = deterministicUnit()

  // When
  const result = await unit.execute(
    command("batch-1"),
    targets(),
    async (_transaction, locked) => ({
      primaryEntityId: "alpha",
      records: [record("beta", requiredTarget(locked, "beta").nextRevision), record("alpha", 2)],
    }),
  )

  // Then
  assert.deepEqual(result.eventIds, ["event-1", "event-2"])
  assert.deepEqual(result.revisions, { alpha: 2, beta: 2 })
  assert.equal(result.eventId, "event-1")
  const rows = await fixture.sql`select
    (select count(*)::integer from entity_revisions where revision=2) revisions,
    (select count(*)::integer from entity_events_v1 where subject_revision=2) events,
    (select count(*)::integer from generic_command_events where idempotency_key='batch-1') receipts`
  assert.deepEqual([...rows], [{ revisions: 2, events: 2, receipts: 2 }])
})

test("batch replay returns all original events without invoking its handler", async () => {
  // Given
  const unit = deterministicUnit()
  await unit.execute(command("batch-2"), targets(), async () => ({
    primaryEntityId: "alpha",
    records: [record("alpha", 2), record("beta", 2)],
  }))
  let invoked = false

  // When
  const replay = await unit.execute(command("batch-2"), targets(), async () => {
    invoked = true
    return { primaryEntityId: "alpha", records: [] }
  })

  // Then
  assert.equal(invoked, false)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.eventIds, ["event-1", "event-2"])
})

test("batch replay fails closed when a secondary target access is revoked", async () => {
  // Given
  const unit = deterministicUnit()
  await unit.execute(command("batch-secondary-revoked"), targets(), async () => ({
    primaryEntityId: "alpha",
    records: [record("alpha", 2), record("beta", 2)],
  }))
  await fixture.sql`update entity_acl_policies set mode='restricted' where entity_id='beta'`

  // When / Then
  await assert.rejects(
    unit.execute(command("batch-secondary-revoked"), targets(), async () => ({
      primaryEntityId: "alpha",
      records: [],
    })),
    (error) => error instanceof EntityNotFoundError && error.entityId === "alpha",
  )
})

test("batch replay fails closed when the original write permission is revoked", async () => {
  // Given
  const unit = deterministicUnit()
  const createTargets = [
    { entityId: "gamma", expectedRevision: null, permission: "work.create" },
  ] as const
  await unit.execute(
    command("batch-write-revoked", "gamma"),
    createTargets,
    async (transaction) => {
      await insertEntity(transaction, {
        id: "gamma",
        workspaceId: "workspace",
        kind: "work_item",
        scopeSpaceId: null,
        actorId: "owner",
      })
      return {
        primaryEntityId: "gamma",
        records: [record("gamma", 1, "entity.created")],
      }
    },
  )
  await fixture.sql`delete from membership_permissions
    where workspace_id='workspace' and principal_id='owner' and permission='work.create'`

  // When / Then
  await assert.rejects(
    unit.execute(command("batch-write-revoked", "gamma"), createTargets, async () => ({
      primaryEntityId: "gamma",
      records: [],
    })),
    (error) => error instanceof EntityNotFoundError && error.entityId === "gamma",
  )
})

test("invalid batch record set rolls back every target", async () => {
  // Given
  const unit = deterministicUnit()

  // When / Then
  await assert.rejects(
    unit.execute(command("batch-invalid"), targets(), async () => ({
      primaryEntityId: "alpha",
      records: [record("alpha", 2)],
    })),
    /record/i,
  )
  const rows =
    await fixture.sql`select id,current_revision::integer revision from entities order by id`
  assert.deepEqual(
    [...rows],
    [
      { id: "alpha", revision: 1 },
      { id: "beta", revision: 1 },
    ],
  )
})

function deterministicUnit(): CommandUnitOfWork {
  let sequence = 0
  return new CommandUnitOfWork(fixture.sql, {
    newEventId: () => `event-${++sequence}`,
    now: () => "2026-10-17T00:00:00.000Z",
  })
}

function command(idempotencyKey: string, primaryEntityId = "alpha") {
  return {
    workspaceId: "workspace",
    principal,
    commandId: `command-${idempotencyKey}`,
    idempotencyKey,
    action: "test.batch",
    route: "test",
    payload: { value: "same" },
    primaryEntityId,
  }
}

function targets() {
  return [
    { entityId: "beta", expectedRevision: 1, permission: "work.update" },
    { entityId: "alpha", expectedRevision: 1, permission: "work.update" },
  ] as const
}

function record(
  entityId: string,
  revision: number,
  eventType: MutationRecord["eventType"] = "entity.updated",
): MutationRecord {
  return {
    entityId,
    kind: "work_item",
    revision,
    schemaVersion: "foundation.test.v1",
    eventType,
    snapshot: { entityId, revision },
    eventData: { entityId },
    result: { entityId },
  }
}

function requiredTarget(
  targetsById: ReadonlyMap<string, { readonly nextRevision: number }>,
  id: string,
): { readonly nextRevision: number } {
  const target = targetsById.get(id)
  if (target === undefined) throw new TypeError("locked target is missing")
  return target
}

async function seedEntity(id: string): Promise<void> {
  await fixture.sql`insert into entities
    (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
    values (${id},'workspace','work_item',1,'owner',now(),now())`
  await fixture.sql`insert into entity_acl_policies values (${id},'inherit')`
  await fixture.sql`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
    values (${id},1,'foundation.test.v1',${fixture.sql.json({ id })},'owner',now(),
      encode(public.digest(convert_to(${JSON.stringify({ id })},'utf8'),'sha256'),'hex'))`
}
