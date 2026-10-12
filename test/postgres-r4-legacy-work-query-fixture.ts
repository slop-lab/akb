import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import type { TestContext } from "node:test"
import { BoardService } from "../src/human-query/board-service.ts"
import { HumanQueryService } from "../src/human-query/service.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import type { AuthenticatedPrincipal } from "../src/identity/types.ts"
import { WORK_PERMISSIONS } from "../src/identity/types.ts"
import { R4CommandService } from "../src/pm/commands/service.ts"
import { migrateDatabase, readMigrationCatalog } from "../src/postgres/migrate.ts"
import {
  actorId,
  eventId,
  humanPrincipalId,
  idempotencyKey,
  spaceId,
  workItemId,
  workItemTitle,
  workspaceId,
} from "../src/work-items/identifiers.ts"
import { PostgresWorkItemStore } from "../src/work-items/postgres-store.ts"
import { createUnmigratedPostgresTestFixture } from "./postgres-fixture.ts"

export type LegacyWorkFixture = {
  readonly database: Awaited<ReturnType<typeof createUnmigratedPostgresTestFixture>>
  readonly principal: AuthenticatedPrincipal
  readonly query: HumanQueryService
  readonly board: BoardService
  readonly commands: R4CommandService
  readonly alphaId: string
  readonly zuluId: string
  readonly stateId: string
  readonly projectId: string
  readonly labelId: string
  readonly immutableBefore: readonly Readonly<Record<string, unknown>>[]
}

export async function createLegacyWorkFixture(context: TestContext): Promise<LegacyWorkFixture> {
  const database = await createUnmigratedPostgresTestFixture()
  const directory = await mkdtemp(join(tmpdir(), "afw-legacy-work-query-"))
  context.after(database.close)
  context.after(() => rm(directory, { recursive: true }))
  await migrateThrough(database.sql, directory, 4)
  await database.sql`insert into workspaces (id,name) values ('legacy','Legacy')`
  await database.sql`insert into principals (id,workspace_id,display_name,kind)
    values ('owner','legacy','Owner','human')`
  await database.sql`insert into workspace_memberships (workspace_id,principal_id,role)
    values ('legacy','owner','owner')`
  await database.sql`insert into spaces (workspace_id,id,name,visibility)
    values ('legacy','old','Old','public')`
  let itemSequence = 0
  const store = new PostgresWorkItemStore(database.sql, {
    newWorkItemId: () => workItemId(itemSequence++ === 0 ? "legacy-alpha" : "legacy-zulu"),
    newEventId: () => eventId(`legacy-event-${itemSequence}`),
    now: () => `2026-01-0${itemSequence + 1}T03:04:05.000Z`,
  })
  const alphaId = await createLegacyWork(store, "Alpha legacy", "alpha")
  const zuluId = await createLegacyWork(store, "Zulu legacy", "zulu")
  await migrateDatabase(database.sql)
  await database.sql`insert into membership_permissions (workspace_id,principal_id,permission)
    select 'legacy','owner',permission from unnest(${database.sql.array([...WORK_PERMISSIONS])}) permission`
  const issued = await new IdentityAdmin(database.sql).issueToken({
    workspaceId: "legacy",
    principalId: "owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  const principal = await authenticateToken(database.sql, issued.token)
  if (principal === undefined) throw new TypeError("legacy fixture authentication failed")
  const commands = new R4CommandService(database.sql)
  const stateRows = await database.sql<{ readonly id: string }[]>`select id from workflow_states
    where workspace_id='legacy' and space_id='old' and category='unstarted'`
  const stateId = required(stateRows[0]?.id)
  const projectId = await executeCreate(commands, principal, "project.create", "legacy-project", {
    name: "Legacy project",
    slug: "legacy-project",
    summary: "",
    ownerId: "owner",
    leadIds: [],
    participatingSpaceIds: ["old"],
    state: "active",
    health: "on_track",
    priority: "none",
    startDate: null,
    targetDate: null,
  })
  const labelId = await executeCreate(
    commands,
    principal,
    "label.create",
    "legacy-label",
    {
      name: "Legacy label",
      color: "blue",
    },
    "old",
  )
  await database.sql`update work_item_pm set project_id=${projectId},description='Frozen description',
    item_type='Bug',priority='high',start_date='2026-01-10',due_date='2026-01-20'
    where work_item_id in (${alphaId},${zuluId})`
  await database.sql`insert into work_item_labels(work_item_id,label_id)
    values (${alphaId},${labelId}),(${zuluId},${labelId})`
  const immutableBefore = await immutableWorkRecords(database.sql, [alphaId, zuluId])
  return {
    database,
    principal,
    query: new HumanQueryService(database.sql, Buffer.alloc(32, 7)),
    board: new BoardService(database.sql, Buffer.alloc(32, 7)),
    commands,
    alphaId,
    zuluId,
    stateId,
    projectId,
    labelId,
    immutableBefore,
  }
}

export async function immutableWorkRecords(
  sql: LegacyWorkFixture["database"]["sql"],
  ids: readonly string[],
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  return sql`select 'revision' kind,entity_id id,revision,schema_version,canonical_snapshot,
      actor_id,cause_event_id,created_at,digest from entity_revisions
      where entity_id in ${sql(ids)} and revision=1
    union all select 'event',subject_id,subject_revision,event_type,to_jsonb(data),actor_id,id,
      occurred_at,'' from entity_events_v1 where subject_id in ${sql(ids)} and subject_revision=1
    order by kind,id,revision`
}

async function createLegacyWork(
  store: PostgresWorkItemStore,
  title: string,
  key: string,
): Promise<string> {
  const result = await store.create({
    workspaceId: workspaceId("legacy"),
    spaceId: spaceId("old"),
    title: workItemTitle(title),
    accountableOwnerId: humanPrincipalId("owner"),
    actorId: actorId("owner"),
    idempotencyKey: idempotencyKey(key),
  })
  if (result.kind !== "created") throw new TypeError("legacy Work creation failed")
  return result.item.id
}

async function executeCreate(
  commands: R4CommandService,
  principal: AuthenticatedPrincipal,
  action: "project.create" | "label.create",
  key: string,
  payload: unknown,
  parentId: string | null = null,
): Promise<string> {
  const result = await commands.execute({
    workspaceId: "legacy",
    principal,
    commandId: key,
    idempotencyKey: key,
    baseRevision: null,
    action,
    route: action,
    resourceId: null,
    parentId,
    payload,
  })
  const id = Reflect.get(result.result, "id")
  return required(typeof id === "string" ? id : undefined)
}

async function migrateThrough(
  sql: LegacyWorkFixture["database"]["sql"],
  directory: string,
  count: number,
): Promise<void> {
  for (const migration of (await readMigrationCatalog()).slice(0, count)) {
    await cp(resolve("migrations", migration.version), join(directory, basename(migration.version)))
  }
  await migrateDatabase(sql, directory)
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("required legacy fixture value missing")
  return value
}
