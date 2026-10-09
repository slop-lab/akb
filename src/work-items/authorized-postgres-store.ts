import { z } from "zod"
import type { Sql, TransactionSql } from "postgres"
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
} from "../identity/authorization-errors.ts"
import { authorizeWorkspace, requireWorkspaceGrant } from "../identity/authorize.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import { accessibleSpaceIds, requireSpacePermissions } from "../identity/space-authorization.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { EventIdSchema, revision } from "./identifiers.ts"
import type { WorkItemId, WorkspaceId } from "./identifiers.ts"
import type { StoreDependencies } from "./in-memory-store.ts"
import type { CreateResult, CreateWorkItem, PatchResult, PatchWorkItem, WorkItem } from "./model.ts"
import { parseWorkItem } from "./postgres-records.ts"
import type { WorkItemList, WorkItemStore } from "./store.ts"
import { createFingerprint } from "./create-fingerprint.ts"

const SequenceSchema = z.object({ sequence: z.coerce.number().int().positive() })
const ReplaySchema = z.object({ fingerprint: z.string(), event_id: EventIdSchema })

export class AuthorizedPostgresWorkItemStore implements WorkItemStore {
  readonly supportsScopedCreate = true
  readonly #sql: Sql
  readonly #context: AuthenticatedPrincipal
  readonly #dependencies: StoreDependencies

  constructor(sql: Sql, context: AuthenticatedPrincipal, dependencies: StoreDependencies) {
    this.#sql = sql
    this.#context = context
    this.#dependencies = dependencies
  }

  async create(command: CreateWorkItem): Promise<CreateResult> {
    return this.#sql.begin(async (transaction) => {
      await authorizeWorkspace(transaction, this.#context, "work.create", command.workspaceId)
      await requireWorkspaceGrant(transaction, this.#context, "work.assign")
      requireActor(command.actorId, this.#context.principalId)
      if (command.spaceId !== undefined) {
        await requireSpacePermissions(
          transaction,
          this.#context,
          command.spaceId,
          ["work.create", "work.assign"],
          true,
        )
      }
      await transaction`select pg_advisory_xact_lock(
        hashtextextended(${JSON.stringify([command.workspaceId, command.idempotencyKey])}, 0)
      )`
      const fingerprint = createFingerprint(command)
      const replayRows = await transaction<{ readonly actor_id: unknown }[]>`
        select i.fingerprint, i.event_id, e.actor_id, r.work_item_id as id, r.workspace_id,
          r.space_id, r.title, r.state, r.accountable_owner_id, r.revision, r.created_at, r.updated_at
        from work_item_idempotency i
        join domain_events e on e.id = i.event_id and e.subject_id = i.work_item_id
        join work_item_revisions r on r.work_item_id = e.subject_id and r.revision = e.subject_revision
        where i.workspace_id = ${command.workspaceId} and i.idempotency_key = ${command.idempotencyKey}
      `
      if (replayRows[0] !== undefined) {
        const replay = ReplaySchema.parse(replayRows[0])
        if (replayRows[0]?.actor_id !== this.#context.principalId) {
          throw new PermissionDeniedError()
        }
        await requireWorkspaceGrant(transaction, this.#context, "work.read")
        const replayed = parseWorkItem(replayRows[0])
        if (replayed.spaceId !== undefined) {
          await requireSpacePermissions(transaction, this.#context, replayed.spaceId, ["work.read"])
        }
        return replay.fingerprint === fingerprint
          ? { kind: "replayed", item: replayed, eventId: replay.event_id }
          : { kind: "idempotency_conflict", idempotencyKey: command.idempotencyKey }
      }
      const ownerRows = await transaction`
        select p.id from principals p
        join workspace_memberships m on m.workspace_id = p.workspace_id and m.principal_id = p.id
        join membership_permissions g on g.workspace_id = m.workspace_id
          and g.principal_id = m.principal_id and g.permission = 'work.read'
        where p.workspace_id = ${command.workspaceId} and p.id = ${command.accountableOwnerId}
          and p.kind = 'human' and p.status = 'active' and m.status = 'active'
          and (${command.spaceId ?? null}::text is null or exists (
            select 1 from spaces s where s.workspace_id = p.workspace_id
              and s.id = ${command.spaceId ?? null}
              and (s.visibility = 'public' or exists (
                select 1 from space_permissions sp where sp.workspace_id = s.workspace_id
                  and sp.space_id = s.id and sp.principal_id = p.id
                  and sp.permission = 'work.read'
              ))
          ))
        for share of p, m, g
      `
      if (ownerRows.length !== 1) throw new PermissionDeniedError()
      const now = this.#dependencies.now()
      const item = Object.freeze({
        id: this.#dependencies.newWorkItemId(),
        workspaceId: command.workspaceId,
        ...(command.spaceId === undefined ? {} : { spaceId: command.spaceId }),
        title: command.title,
        state: "unstarted",
        accountableOwnerId: command.accountableOwnerId,
        revision: revision(1),
        createdAt: now,
        updatedAt: now,
      } satisfies WorkItem)
      const eventId = this.#dependencies.newEventId()
      await insertCurrent(transaction, item)
      await insertRevision(transaction, item)
      const sequence = await nextSequence(transaction, item.workspaceId)
      await transaction`insert into domain_events
        (id, workspace_id, space_id, sequence, event_type, occurred_at, actor_id, subject_id, subject_revision, changed_fields)
        values (${eventId}, ${item.workspaceId}, ${item.spaceId ?? null}, ${sequence}, 'work_item.created', ${now},
          ${this.#context.principalId}, ${item.id}, ${item.revision}, null)`
      await transaction`insert into work_item_idempotency
        (workspace_id, idempotency_key, fingerprint, work_item_id, event_id)
        values (${command.workspaceId}, ${command.idempotencyKey}, ${fingerprint}, ${item.id}, ${eventId})`
      return { kind: "created", item, eventId }
    })
  }

  async patch(command: PatchWorkItem): Promise<PatchResult> {
    return this.#sql.begin(async (transaction) => {
      if (!(await lockAuthenticatedPrincipal(transaction, this.#context))) {
        throw new AuthenticationRequiredError()
      }
      requireActor(command.actorId, this.#context.principalId)
      const rows = await transaction`select w.* from work_items w
        where w.id = ${command.id} and w.workspace_id = ${this.#context.workspaceId}
          and exists (select 1 from membership_permissions g
            where g.workspace_id = w.workspace_id
              and g.principal_id = ${this.#context.principalId}
              and g.permission = 'work.update')
          and (w.space_id is null or exists (select 1 from spaces s
            where s.workspace_id = w.workspace_id and s.id = w.space_id
              and (s.visibility = 'public' or exists (select 1 from space_permissions sp
                where sp.workspace_id = s.workspace_id and sp.space_id = s.id
                  and sp.principal_id = ${this.#context.principalId}
                  and sp.permission = 'work.update'))))
        for update of w`
      if (rows[0] === undefined) return { kind: "not_found", id: command.id }
      const current = parseWorkItem(rows[0])
      if (current.revision !== command.baseRevision) {
        return {
          kind: "revision_conflict",
          expected: command.baseRevision,
          actual: current.revision,
        }
      }
      const changedFields = [
        ...(command.title !== undefined && command.title !== current.title
          ? ["title" as const]
          : []),
        ...(command.state !== undefined && command.state !== current.state
          ? ["state" as const]
          : []),
      ]
      if (changedFields.length === 0) return { kind: "unchanged", item: current }
      const next = Object.freeze({
        ...current,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.state === undefined ? {} : { state: command.state }),
        revision: revision(current.revision + 1),
        updatedAt: this.#dependencies.now(),
      } satisfies WorkItem)
      const eventId = this.#dependencies.newEventId()
      await transaction`update work_items set title = ${next.title}, state = ${next.state},
        revision = ${next.revision}, updated_at = ${next.updatedAt} where id = ${next.id}`
      await insertRevision(transaction, next)
      const sequence = await nextSequence(transaction, next.workspaceId)
      await transaction`insert into domain_events
        (id, workspace_id, space_id, sequence, event_type, occurred_at, actor_id, subject_id, subject_revision, changed_fields)
        values (${eventId}, ${next.workspaceId}, ${next.spaceId ?? null}, ${sequence}, 'work_item.updated', ${next.updatedAt},
          ${this.#context.principalId}, ${next.id}, ${next.revision}, ${transaction.array(changedFields)})`
      return { kind: "updated", item: next, eventId }
    })
  }

  async get(id: WorkItemId): Promise<WorkItem | undefined> {
    return this.#sql.begin("isolation level read committed", async (transaction) => {
      if (!(await lockAuthenticatedPrincipal(transaction, this.#context)))
        throw new AuthenticationRequiredError()
      const rows = await transaction`select w.* from work_items w
        where w.id = ${id} and w.workspace_id = ${this.#context.workspaceId}
          and exists (select 1 from membership_permissions g
            where g.workspace_id = w.workspace_id
              and g.principal_id = ${this.#context.principalId}
              and g.permission = 'work.read')
          and (w.space_id is null or exists (select 1 from spaces s
            where s.workspace_id = w.workspace_id and s.id = w.space_id
              and (s.visibility = 'public' or exists (select 1 from space_permissions sp
                where sp.workspace_id = s.workspace_id and sp.space_id = s.id
                  and sp.principal_id = ${this.#context.principalId}
                  and sp.permission = 'work.read'))))`
      return rows[0] === undefined ? undefined : parseWorkItem(rows[0])
    })
  }

  async list(workspaceId: WorkspaceId, limit: number): Promise<WorkItemList> {
    return this.#sql.begin("isolation level read committed", async (transaction) => {
      await authorizeWorkspace(transaction, this.#context, "work.read", workspaceId)
      const accessible = await accessibleSpaceIds(transaction, this.#context, "work.read")
      const rows = await transaction`select * from work_items w where workspace_id = ${workspaceId}
        and (w.space_id is null or w.space_id = any(${transaction.array([...accessible])}))
        order by created_at, id limit ${limit}`
      const counts = await transaction<{ readonly matched: number }[]>`
        select count(*)::integer as matched from work_items w where workspace_id = ${workspaceId}
          and (w.space_id is null or w.space_id = any(${transaction.array([...accessible])}))`
      return {
        items: Object.freeze(rows.map(parseWorkItem)),
        matched: z
          .number()
          .int()
          .nonnegative()
          .parse(counts[0]?.matched ?? 0),
      }
    })
  }
}

function requireActor(actor: string, principalId: string): void {
  if (actor !== principalId) throw new PermissionDeniedError()
}

async function nextSequence(
  transaction: TransactionSql,
  workspaceId: WorkspaceId,
): Promise<number> {
  const rows = await transaction`insert into workspace_event_sequences (workspace_id, last_sequence)
    values (${workspaceId}, 1) on conflict (workspace_id) do update
    set last_sequence = workspace_event_sequences.last_sequence + 1 returning last_sequence as sequence`
  return SequenceSchema.parse(rows[0]).sequence
}

async function insertCurrent(transaction: TransactionSql, item: WorkItem): Promise<void> {
  await transaction`insert into work_items
    (id, workspace_id, space_id, title, state, accountable_owner_id, revision, created_at, updated_at)
    values (${item.id}, ${item.workspaceId}, ${item.spaceId ?? null}, ${item.title}, ${item.state},
      ${item.accountableOwnerId}, ${item.revision}, ${item.createdAt}, ${item.updatedAt})`
}

async function insertRevision(transaction: TransactionSql, item: WorkItem): Promise<void> {
  await transaction`insert into work_item_revisions
    (work_item_id, workspace_id, space_id, title, state, accountable_owner_id, revision, created_at, updated_at)
    values (${item.id}, ${item.workspaceId}, ${item.spaceId ?? null}, ${item.title}, ${item.state},
      ${item.accountableOwnerId}, ${item.revision}, ${item.createdAt}, ${item.updatedAt})`
}
