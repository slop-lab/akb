import { createHash } from "node:crypto"
import type { TransactionSql } from "postgres"
import { z } from "zod"
import type {
  BatchCommandInput,
  BatchMutationResult,
  CommandTarget,
  LockedCommandTarget,
  MutationBatch,
} from "./command-unit-of-work.ts"
import { CommandInvariantError } from "./errors.ts"
import type { MutationRecord } from "./mutation-types.ts"

const RevisionRowSchema = z.strictObject({ current_revision: z.coerce.number().int().positive() })
const SequenceRowSchema = z.strictObject({ sequence: z.coerce.number().int().positive() })

type BatchEvent = { readonly entityId: string; readonly eventId: string }
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export function validateCommandTargets(
  input: BatchCommandInput,
  targets: readonly CommandTarget[],
): readonly CommandTarget[] {
  if (targets.length === 0) throw new CommandInvariantError("batch_targets_required")
  if (!targets.some((target) => target.entityId === input.primaryEntityId)) {
    throw new CommandInvariantError("batch_primary_target_missing")
  }
  const ordered = [...targets].sort((left, right) => left.entityId.localeCompare(right.entityId))
  if (ordered.some((target, index) => target.entityId === ordered[index - 1]?.entityId)) {
    throw new CommandInvariantError("batch_target_duplicate")
  }
  return ordered
}

export function validateBatchRecords(
  batch: MutationBatch,
  targets: readonly CommandTarget[],
  locked: ReadonlyMap<string, LockedCommandTarget>,
): readonly MutationRecord[] {
  if (batch.records.length !== targets.length) {
    throw new CommandInvariantError("batch_record_count_invalid")
  }
  const records = new Map(batch.records.map((record) => [record.entityId, record]))
  if (records.size !== batch.records.length)
    throw new CommandInvariantError("batch_record_duplicate")
  for (const target of targets) {
    const record = records.get(target.entityId)
    const expected = locked.get(target.entityId)
    if (
      record === undefined ||
      expected === undefined ||
      record.revision !== expected.nextRevision
    ) {
      throw new CommandInvariantError("batch_record_revision_invalid")
    }
  }
  return targets.map((target) => records.get(target.entityId)).filter(isMutationRecord)
}

export function parseCurrentRevision(row: unknown): number {
  return RevisionRowSchema.parse(row).current_revision
}

export function commandFingerprint(
  input: BatchCommandInput,
  targets: readonly CommandTarget[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...input, principal: input.principal.principalId, targets }))
    .digest("hex")
}

export function buildBatchResult(values: {
  readonly input: BatchCommandInput
  readonly primary: MutationRecord
  readonly eventId: string
  readonly events: readonly BatchEvent[]
  readonly records: readonly MutationRecord[]
}): BatchMutationResult {
  const { input, primary, eventId, events, records } = values
  return {
    commandId: input.commandId,
    eventId,
    eventIds: events.map((event) => event.eventId),
    result: primary.result,
    revision: primary.revision,
    revisions: Object.fromEntries(records.map((record) => [record.entityId, record.revision])),
    replayed: false,
    warnings: [],
  }
}

export async function appendCommandRecord(
  transaction: TransactionSql,
  values: {
    readonly input: BatchCommandInput
    readonly record: MutationRecord
    readonly eventId: string
    readonly occurredAt: string
  },
): Promise<void> {
  const { input, record, eventId, occurredAt } = values
  const target =
    await transaction`select current_revision from entities where id=${record.entityId}`
  if (target.length > 0) {
    const archived =
      record.eventType === "entity.archived" || record.eventType === "relation.archived"
    await transaction`update entities set current_revision=${record.revision},
      lifecycle=${archived ? "archived" : record.eventType === "entity.restored" ? "active" : transaction`lifecycle`},
      archived_at=${archived ? occurredAt : record.eventType === "entity.restored" ? null : transaction`archived_at`},
      updated_at=${occurredAt} where workspace_id=${input.workspaceId} and id=${record.entityId}`
  }
  await transaction`insert into entity_revisions
    (entity_id,revision,schema_version,canonical_snapshot,actor_id,cause_event_id,created_at,digest)
    values (${record.entityId},${record.revision},${record.schemaVersion},
      ${transaction.json(toJsonValue(record.snapshot))},${input.principal.principalId},${eventId},
      ${occurredAt},encode(public.digest(convert_to(${JSON.stringify(record.snapshot)},'utf8'),'sha256'),'hex'))`
  const sequenceRows =
    await transaction`insert into entity_event_sequences values (${input.workspaceId},1)
    on conflict (workspace_id) do update set last_sequence=entity_event_sequences.last_sequence+1
    returning last_sequence as sequence`
  const sequence = SequenceRowSchema.parse(sequenceRows[0]).sequence
  await transaction`insert into entity_events_v1
    (id,workspace_id,sequence,event_type,subject_kind,subject_id,subject_revision,
     occurred_at,actor_id,data)
    values (${eventId},${input.workspaceId},${sequence},${record.eventType},${record.kind},
      ${record.entityId},${record.revision},${occurredAt},${input.principal.principalId},
      ${transaction.json(toJsonValue(record.eventData))})`
}

export function toJsonValue(value: unknown): JsonValue {
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

function isMutationRecord(record: MutationRecord | undefined): record is MutationRecord {
  return record !== undefined
}
