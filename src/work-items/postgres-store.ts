import { z } from "zod"
import type { Sql, TransactionSql } from "postgres"
import { EventIdSchema, revision } from "./identifiers.ts"
import type { WorkItemId, WorkspaceId } from "./identifiers.ts"
import type { StoreDependencies } from "./in-memory-store.ts"
import type {
  CreateResult,
  CreateWorkItem,
  PatchResult,
  PatchWorkItem,
  WorkItem,
  WorkItemEvent,
  WorkItemRevision,
} from "./model.ts"
import { parseEvent, parseWorkItem } from "./postgres-records.ts"
import type { WorkItemList, WorkItemStore } from "./store.ts"
import { createFingerprint } from "./create-fingerprint.ts"

const SequenceRecordSchema = z.strictObject({ sequence: z.coerce.number().int().positive() })
const IdempotencyRecordSchema = z.strictObject({
  fingerprint: z.string(),
  event_id: EventIdSchema,
  id: z.string(),
  workspace_id: z.string(),
  space_id: z.string().nullable(),
  title: z.string(),
  state: z.string(),
  accountable_owner_id: z.string(),
  revision: z.union([z.string(), z.number()]),
  created_at: z.date(),
  updated_at: z.date(),
})

export class PostgresWorkItemStore implements WorkItemStore {
  readonly supportsScopedCreate = true
  readonly #sql: Sql
  readonly #dependencies: StoreDependencies

  constructor(sql: Sql, dependencies: StoreDependencies) {
    this.#sql = sql
    this.#dependencies = dependencies
  }

  async create(command: CreateWorkItem): Promise<CreateResult> {
    const fingerprint = createFingerprint(command)
    return this.#sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(
        hashtextextended(${JSON.stringify([command.workspaceId, command.idempotencyKey])}, 0)
      )`
      const priorRows = await transaction`
        select i.fingerprint, i.event_id, r.work_item_id as id, r.workspace_id, r.space_id, r.title,
          r.state, r.accountable_owner_id, r.revision, r.created_at, r.updated_at
        from work_item_idempotency i
        join domain_events e on e.id = i.event_id and e.subject_id = i.work_item_id
        join work_item_revisions r
          on r.work_item_id = e.subject_id and r.revision = e.subject_revision
        where i.workspace_id = ${command.workspaceId}
          and i.idempotency_key = ${command.idempotencyKey}
      `
      const priorRecord = priorRows[0]
      if (priorRecord !== undefined) {
        const prior = IdempotencyRecordSchema.parse(priorRecord)
        return prior.fingerprint === fingerprint
          ? { kind: "replayed", item: parseWorkItem(priorRecord), eventId: prior.event_id }
          : { kind: "idempotency_conflict", idempotencyKey: command.idempotencyKey }
      }

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
      await transaction`
        insert into domain_events
          (id, workspace_id, space_id, sequence, event_type, occurred_at, actor_id, subject_id,
           subject_revision, changed_fields)
        values (${eventId}, ${item.workspaceId}, ${item.spaceId ?? null}, ${sequence}, 'work_item.created', ${now},
          ${command.actorId}, ${item.id}, ${item.revision}, null)
      `
      await transaction`
        insert into work_item_idempotency
          (workspace_id, idempotency_key, fingerprint, work_item_id, event_id)
        values (${command.workspaceId}, ${command.idempotencyKey}, ${fingerprint},
          ${item.id}, ${eventId})
      `
      return { kind: "created", item, eventId }
    })
  }

  async patch(command: PatchWorkItem): Promise<PatchResult> {
    return this.#sql.begin(async (transaction) => {
      const rows = await transaction`select * from work_items where id = ${command.id} for update`
      const record = rows[0]
      if (record === undefined) return { kind: "not_found", id: command.id }
      const current = parseWorkItem(record)
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
      ] satisfies readonly ("title" | "state")[]
      if (changedFields.length === 0) return { kind: "unchanged", item: current }

      const next = Object.freeze({
        ...current,
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.state === undefined ? {} : { state: command.state }),
        revision: revision(current.revision + 1),
        updatedAt: this.#dependencies.now(),
      } satisfies WorkItem)
      const eventId = this.#dependencies.newEventId()
      await transaction`
        update work_items set title = ${next.title}, state = ${next.state},
          revision = ${next.revision}, updated_at = ${next.updatedAt}
        where id = ${next.id}
      `
      await insertRevision(transaction, next)
      const sequence = await nextSequence(transaction, next.workspaceId)
      await transaction`
        insert into domain_events
          (id, workspace_id, space_id, sequence, event_type, occurred_at, actor_id, subject_id,
           subject_revision, changed_fields)
        values (${eventId}, ${next.workspaceId}, ${next.spaceId ?? null}, ${sequence}, 'work_item.updated',
          ${next.updatedAt}, ${command.actorId}, ${next.id}, ${next.revision},
          ${transaction.array([...changedFields])})
      `
      return { kind: "updated", item: next, eventId }
    })
  }

  async get(id: WorkItemId): Promise<WorkItem | undefined> {
    const rows = await this.#sql`select * from work_items where id = ${id}`
    return rows[0] === undefined ? undefined : parseWorkItem(rows[0])
  }

  async list(workspaceId: WorkspaceId, limit: number): Promise<WorkItemList> {
    return this.#sql.begin("read only isolation level repeatable read", async (transaction) => {
      const rows = await transaction`
        select * from work_items where workspace_id = ${workspaceId}
        order by created_at, id limit ${limit}
      `
      const countRows = await transaction<{ readonly matched: number }[]>`
        select count(*)::integer as matched from work_items where workspace_id = ${workspaceId}
      `
      const matched = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(countRows[0]?.matched ?? 0)
      return { items: Object.freeze(rows.map(parseWorkItem)), matched }
    })
  }

  async history(id: WorkItemId): Promise<readonly WorkItemRevision[]> {
    const rows = await this.#sql`
      select work_item_id as id, workspace_id, space_id, title, state, accountable_owner_id,
        revision, created_at, updated_at
      from work_item_revisions where work_item_id = ${id} order by revision
    `
    return Object.freeze(rows.map(parseWorkItem))
  }

  async events(): Promise<readonly WorkItemEvent[]> {
    const rows = await this.#sql`select * from domain_events order by workspace_id, sequence`
    return Object.freeze(rows.map(parseEvent))
  }
}

async function nextSequence(
  transaction: TransactionSql,
  workspaceId: WorkspaceId,
): Promise<number> {
  const rows = await transaction`
    insert into workspace_event_sequences (workspace_id, last_sequence) values (${workspaceId}, 1)
    on conflict (workspace_id) do update
      set last_sequence = workspace_event_sequences.last_sequence + 1
    returning last_sequence as sequence
  `
  return SequenceRecordSchema.parse(rows[0]).sequence
}

async function insertCurrent(transaction: TransactionSql, item: WorkItem): Promise<void> {
  await transaction`
    insert into work_items
      (id, workspace_id, space_id, title, state, accountable_owner_id, revision, created_at, updated_at)
    values (${item.id}, ${item.workspaceId}, ${item.spaceId ?? null}, ${item.title}, ${item.state},
      ${item.accountableOwnerId}, ${item.revision}, ${item.createdAt}, ${item.updatedAt})
  `
}

async function insertRevision(transaction: TransactionSql, item: WorkItem): Promise<void> {
  await transaction`
    insert into work_item_revisions
      (work_item_id, workspace_id, space_id, title, state, accountable_owner_id, revision,
       created_at, updated_at)
    values (${item.id}, ${item.workspaceId}, ${item.spaceId ?? null}, ${item.title}, ${item.state},
      ${item.accountableOwnerId}, ${item.revision}, ${item.createdAt}, ${item.updatedAt})
  `
}
