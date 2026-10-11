import { createHash, randomUUID } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import { CommandResultSchema } from "../contracts/r4/command.ts"
import { authorizeWorkspace } from "../identity/authorize.ts"
import {
  CommandIdempotencyConflictError,
  EntityNotFoundError,
  EntityRevisionConflictError,
} from "./errors.ts"
import type { MutationCallback, MutationInput, MutationResult } from "./mutation-types.ts"
import { entityReadPermission } from "./read-permission.ts"

const CurrentEntitySchema = z.strictObject({ current_revision: z.coerce.number().int().positive() })
const ReplaySchema = z.strictObject({
  fingerprint: z.string(),
  event_id: z.string(),
  subject_id: z.string(),
  result_revision: z.coerce.number().int().positive(),
  result: z.record(z.string(), z.unknown()),
  kind: z.string(),
})
const SequenceSchema = z.strictObject({ sequence: z.coerce.number().int().positive() })

export class EntityMutationEngine {
  readonly #sql: Sql | TransactionSql
  readonly #newEventId: () => string
  readonly #now: () => string

  constructor(
    sql: Sql | TransactionSql,
    dependencies: {
      readonly newEventId?: () => string
      readonly now?: () => string
    } = {},
  ) {
    this.#sql = sql
    this.#newEventId = dependencies.newEventId ?? randomUUID
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async mutate(input: MutationInput, callback: MutationCallback): Promise<MutationResult> {
    if (!("begin" in this.#sql)) return this.mutateInTransaction(this.#sql, input, callback)
    return this.#sql.begin((transaction) => this.mutateInTransaction(transaction, input, callback))
  }

  async mutateInTransaction(
    transaction: TransactionSql,
    input: MutationInput,
    callback: MutationCallback,
  ): Promise<MutationResult> {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          action: input.action,
          route: input.route,
          workspaceId: input.workspaceId,
          targetEntityId: input.targetEntityId,
          resourceId: input.resourceId,
          parentId: input.parentId,
          principalId: input.principal.principalId,
          baseRevision: input.baseRevision,
          payload: input.payload,
        }),
      )
      .digest("hex")
    await transaction`select id from workspaces where id = ${input.workspaceId}
        and status = 'active' for update`
    await authorizeWorkspace(transaction, input.principal, input.permission, input.workspaceId)
    await transaction`select pg_advisory_xact_lock(
        hashtextextended(${JSON.stringify([input.workspaceId, input.idempotencyKey])}, 0))`
    const replay = await this.#replay(transaction, input, fingerprint)
    if (replay !== undefined) return replay
    const revision = await this.#lockTarget(transaction, input)
    const record = await callback(transaction, revision)
    const eventId = this.#newEventId()
    const occurredAt = this.#now()
    await this.#append(transaction, input, record, eventId, occurredAt)
    if (record.postEvent !== undefined) await record.postEvent(eventId, occurredAt)
    const result = {
      commandId: input.commandId,
      eventId,
      result: record.result,
      revision: record.revision,
      replayed: false,
      warnings: [],
    } satisfies MutationResult
    await transaction`insert into generic_command_idempotency
        (workspace_id, idempotency_key, command_id, principal_id, action, route, fingerprint,
         event_id, subject_id, result_revision, result)
        values (${input.workspaceId}, ${input.idempotencyKey}, ${input.commandId},
          ${input.principal.principalId}, ${input.action}, ${input.route}, ${fingerprint},
          ${eventId}, ${record.entityId}, ${record.revision}, ${transaction.json(toJsonValue(result))})`
    return result
  }

  async #replay(
    transaction: TransactionSql,
    input: MutationInput,
    fingerprint: string,
  ): Promise<MutationResult | undefined> {
    const rows = await transaction`select i.fingerprint,i.event_id,i.subject_id,i.result_revision,
        i.result,e.kind from generic_command_idempotency i join entities e on e.id=i.subject_id
      where i.workspace_id = ${input.workspaceId} and i.idempotency_key = ${input.idempotencyKey}
      for update of i`
    if (rows[0] === undefined) return undefined
    const replay = ReplaySchema.parse(rows[0])
    const readPermission = entityReadPermission(replay.kind)
    if (readPermission === null) throw new EntityNotFoundError(replay.subject_id)
    const access = await transaction`select 1 where entity_access_allowed(${input.workspaceId},
      ${replay.subject_id}, ${input.principal.principalId}, ${readPermission})`
    if (access.length !== 1) throw new EntityNotFoundError(replay.subject_id)
    if (replay.fingerprint !== fingerprint) {
      throw new CommandIdempotencyConflictError(input.idempotencyKey)
    }
    const result = CommandResultSchema.parse(replay.result)
    if (result.eventId === null)
      throw new TypeError("stored command result is missing its event ID")
    return { ...result, eventId: result.eventId, replayed: true }
  }

  async #lockTarget(transaction: TransactionSql, input: MutationInput): Promise<number> {
    if (input.targetEntityId === null) {
      if (input.baseRevision !== null) throw new EntityRevisionConflictError(0, input.baseRevision)
      return 1
    }
    const rows = await transaction`select current_revision from entities
      where workspace_id = ${input.workspaceId} and id = ${input.targetEntityId}
        and entity_access_allowed(workspace_id, id, ${input.principal.principalId}, ${input.permission})
      for update`
    if (rows[0] === undefined) throw new EntityNotFoundError(input.targetEntityId)
    const current = CurrentEntitySchema.parse(rows[0]).current_revision
    if (input.baseRevision === null || current !== input.baseRevision) {
      throw new EntityRevisionConflictError(input.baseRevision ?? 0, current)
    }
    return current + 1
  }

  async #append(
    transaction: TransactionSql,
    input: MutationInput,
    record: Awaited<ReturnType<MutationCallback>>,
    eventId: string,
    occurredAt: string,
  ): Promise<void> {
    if (input.targetEntityId !== null) {
      await transaction`update entities set current_revision = ${record.revision},
        lifecycle = ${record.eventType === "entity.archived" ? "archived" : record.eventType === "entity.restored" ? "active" : transaction`lifecycle`},
        archived_at = ${record.eventType === "entity.archived" ? occurredAt : record.eventType === "entity.restored" ? null : transaction`archived_at`},
        updated_at = ${occurredAt} where id = ${record.entityId}`
    }
    await transaction`insert into entity_revisions
      (entity_id, revision, schema_version, canonical_snapshot, actor_id, cause_event_id,
       created_at, digest)
      values (${record.entityId}, ${record.revision}, ${record.schemaVersion},
        ${transaction.json(toJsonValue(record.snapshot))}, ${input.principal.principalId}, ${eventId},
        ${occurredAt}, encode(public.digest(convert_to(${JSON.stringify(record.snapshot)}, 'utf8'),'sha256'),'hex'))`
    const sequenceRows =
      await transaction`insert into entity_event_sequences values (${input.workspaceId}, 1)
      on conflict (workspace_id) do update
        set last_sequence = entity_event_sequences.last_sequence + 1
      returning last_sequence as sequence`
    const sequence = SequenceSchema.parse(sequenceRows[0]).sequence
    await transaction`insert into entity_events_v1
      (id, workspace_id, sequence, event_type, subject_kind, subject_id, subject_revision,
       occurred_at, actor_id, data)
      values (${eventId}, ${input.workspaceId}, ${sequence}, ${record.eventType}, ${record.kind},
        ${record.entityId}, ${record.revision}, ${occurredAt}, ${input.principal.principalId},
        ${transaction.json(toJsonValue(record.eventData))})`
  }
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    )
  }
  throw new TypeError("command value is not JSON-compatible")
}
