import { randomUUID } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
  WorkspaceNotFoundError,
} from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal, WorkPermission } from "../identity/types.ts"
import {
  appendCommandRecord,
  buildBatchResult,
  commandFingerprint,
  parseCurrentRevision,
  toJsonValue,
  validateBatchRecords,
  validateCommandTargets,
} from "./command-unit-of-work-support.ts"
import {
  CommandIdempotencyConflictError,
  CommandInvariantError,
  EntityNotFoundError,
  EntityRevisionConflictError,
} from "./errors.ts"
import type { JsonObject, MutationRecord, MutationResult } from "./mutation-types.ts"

const ReplayRowSchema = z.strictObject({ fingerprint: z.string(), result: z.unknown() })
const BatchResultSchema = z.strictObject({
  commandId: z.string(),
  eventId: z.string(),
  eventIds: z.array(z.string()).readonly(),
  result: z.record(z.string(), z.unknown()),
  revision: z.number().int().positive(),
  revisions: z.record(z.string(), z.number().int().positive()),
  replayed: z.boolean(),
  warnings: z.array(z.string()).readonly(),
})

export type CommandTarget = {
  readonly entityId: string
  readonly expectedRevision: number | null
  readonly permission: WorkPermission
}

export type BatchCommandInput = {
  readonly workspaceId: string
  readonly principal: AuthenticatedPrincipal
  readonly commandId: string
  readonly idempotencyKey: string
  readonly action: string
  readonly route: string
  readonly payload: unknown
  readonly primaryEntityId: string
}

export type LockedCommandTarget = CommandTarget & {
  readonly nextRevision: number
}

export type MutationBatch = {
  readonly primaryEntityId: string
  readonly records: readonly MutationRecord[]
}

export type BatchMutationHandler = (
  transaction: TransactionSql,
  targets: ReadonlyMap<string, LockedCommandTarget>,
) => Promise<MutationBatch>

export type BatchMutationResult = MutationResult & {
  readonly eventIds: readonly string[]
  readonly revisions: Readonly<Record<string, number>>
}

export class CommandUnitOfWork {
  readonly #sql: Sql | TransactionSql
  readonly #newEventId: () => string
  readonly #now: () => string

  constructor(
    sql: Sql | TransactionSql,
    dependencies: { readonly newEventId?: () => string; readonly now?: () => string } = {},
  ) {
    this.#sql = sql
    this.#newEventId = dependencies.newEventId ?? randomUUID
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async execute(
    input: BatchCommandInput,
    targets: readonly CommandTarget[],
    handler: BatchMutationHandler,
  ): Promise<BatchMutationResult> {
    const operation = { input, targets, handler }
    if (!("begin" in this.#sql)) return this.#executeTransaction(this.#sql, operation)
    return this.#sql.begin((transaction) => this.#executeTransaction(transaction, operation))
  }

  async #executeTransaction(
    transaction: TransactionSql,
    operation: {
      readonly input: BatchCommandInput
      readonly targets: readonly CommandTarget[]
      readonly handler: BatchMutationHandler
    },
  ): Promise<BatchMutationResult> {
    const { input, targets, handler } = operation
    const ordered = validateCommandTargets(input, targets)
    if (!(await lockAuthenticatedPrincipal(transaction, input.principal))) {
      throw new AuthenticationRequiredError()
    }
    if (input.workspaceId !== input.principal.workspaceId) throw new WorkspaceNotFoundError()
    await transaction`select pg_advisory_xact_lock(
      hashtextextended(${JSON.stringify([input.workspaceId, input.idempotencyKey])},0))`
    const fingerprint = commandFingerprint(input, ordered)
    const replay = await this.#replay(transaction, input, ordered, fingerprint)
    if (replay !== undefined) return replay
    const locked = new Map<string, LockedCommandTarget>()
    for (const target of ordered) {
      await transaction`select pg_advisory_xact_lock(
        hashtextextended(${JSON.stringify([input.workspaceId, target.entityId])},0))`
      const grant = await transaction`select 1 from membership_permissions
        where workspace_id=${input.workspaceId} and principal_id=${input.principal.principalId}
          and permission=${target.permission} for share`
      if (grant.length !== 1) throw new PermissionDeniedError()
      const rows = await transaction`select current_revision from entities
        where workspace_id=${input.workspaceId} and id=${target.entityId} for update`
      if (target.expectedRevision === null) {
        if (rows.length !== 0)
          throw new EntityRevisionConflictError(0, parseCurrentRevision(rows[0]))
        locked.set(target.entityId, { ...target, nextRevision: 1 })
        continue
      }
      if (rows[0] === undefined) throw new EntityNotFoundError(target.entityId)
      const access = await transaction<
        { readonly allowed: boolean }[]
      >`select entity_access_allowed(${input.workspaceId},
        ${target.entityId},${input.principal.principalId},${target.permission}) allowed`
      if (access[0]?.allowed !== true) throw new EntityNotFoundError(target.entityId)
      const current = parseCurrentRevision(rows[0])
      if (current !== target.expectedRevision) {
        throw new EntityRevisionConflictError(target.expectedRevision, current)
      }
      locked.set(target.entityId, { ...target, nextRevision: current + 1 })
    }
    const batch = await handler(transaction, locked)
    const records = validateBatchRecords(batch, ordered, locked)
    const occurredAt = this.#now()
    const events: { readonly entityId: string; readonly eventId: string }[] = []
    for (const record of records) {
      const eventId = this.#newEventId()
      await appendCommandRecord(transaction, { input, record, eventId, occurredAt })
      events.push({ entityId: record.entityId, eventId })
    }
    for (const [index, record] of records.entries()) {
      const event = events[index]
      if (event === undefined) throw new CommandInvariantError("batch_event_missing")
      if (record.postEvent !== undefined) await record.postEvent(event.eventId, occurredAt)
    }
    const primaryIndex = records.findIndex((record) => record.entityId === batch.primaryEntityId)
    const primary = records[primaryIndex]
    const primaryEvent = events[primaryIndex]
    if (primary === undefined || primaryEvent === undefined) {
      throw new CommandInvariantError("batch_primary_record_missing")
    }
    const result = buildBatchResult({
      input,
      primary,
      eventId: primaryEvent.eventId,
      events,
      records,
    })
    await transaction`insert into generic_command_idempotency
      (workspace_id,idempotency_key,command_id,principal_id,action,route,fingerprint,
       event_id,subject_id,result_revision,result)
      values (${input.workspaceId},${input.idempotencyKey},${input.commandId},
        ${input.principal.principalId},${input.action},${input.route},${fingerprint},
        ${primaryEvent.eventId},${primary.entityId},${primary.revision},
        ${transaction.json(toJsonValue(result))})`
    for (const [ordinal, event] of events.entries()) {
      await transaction`insert into generic_command_events
        (workspace_id,idempotency_key,ordinal,event_id)
        values (${input.workspaceId},${input.idempotencyKey},${ordinal},${event.eventId})`
    }
    return result
  }

  async #replay(
    transaction: TransactionSql,
    input: BatchCommandInput,
    targets: readonly CommandTarget[],
    fingerprint: string,
  ): Promise<BatchMutationResult | undefined> {
    const rows = await transaction`select fingerprint,result from generic_command_idempotency
      where workspace_id=${input.workspaceId} and idempotency_key=${input.idempotencyKey} for update`
    if (rows[0] === undefined) return undefined
    const replay = ReplayRowSchema.parse(rows[0])
    if (replay.fingerprint !== fingerprint) {
      throw new CommandIdempotencyConflictError(input.idempotencyKey)
    }
    for (const target of targets) {
      const grant = await transaction`select 1 from membership_permissions
        where workspace_id=${input.workspaceId} and principal_id=${input.principal.principalId}
          and permission=${target.permission} for share`
      if (grant.length !== 1) throw new EntityNotFoundError(input.primaryEntityId)
      const access = await transaction<
        { readonly allowed: boolean }[]
      >`select entity_access_allowed(${input.workspaceId},${target.entityId},
        ${input.principal.principalId},${target.permission}) allowed`
      if (access[0]?.allowed !== true) throw new EntityNotFoundError(input.primaryEntityId)
    }
    return { ...BatchResultSchema.parse(replay.result), replayed: true }
  }
}

export type CommandReceipt = {
  readonly commandId: string
  readonly primaryEntityId: string
  readonly result: JsonObject
}
