import type { TransactionSql } from "postgres"
import { z } from "zod"
import { CommandInvariantError, EntityNotFoundError } from "../../entities/errors.ts"
import type { JsonObject, MutationRecord } from "../../entities/mutation-types.ts"
import { projectSnapshot } from "./project-command-persistence.ts"
import { spaceSnapshot } from "./space-command-persistence.ts"
import type { CommandCall } from "./types.ts"
import {
  appendLegacyEvent,
  appendLegacyRevision,
  workSnapshot,
} from "./work-item-command-persistence.ts"

const AccessEntityKindSchema = z.enum([
  "work_item",
  "project",
  "space",
  "workflow",
  "workflow_state",
  "label",
  "relation",
  "thread",
  "comment",
  "saved_view",
])
type AccessEntityKind = z.infer<typeof AccessEntityKindSchema>
type AccessRevision = {
  readonly entityId: string
  readonly revision: number
  readonly kind: AccessEntityKind
}
type AccessRecord = AccessRevision & {
  readonly schemaVersion: string
  readonly snapshot: JsonObject
  readonly postEvent?: (eventId: string, occurredAt: string) => Promise<void>
}
const EntityKindSchema = z.strictObject({ kind: AccessEntityKindSchema })
const SnapshotSchema = z.strictObject({ snapshot: z.record(z.string(), z.unknown()) })

export async function requireAccessEntityKind(
  transaction: TransactionSql,
  entityId: string,
): Promise<AccessEntityKind> {
  const entityRows = await transaction`select kind from entities where id=${entityId}`
  const parsed = EntityKindSchema.safeParse(entityRows[0])
  if (!parsed.success) throw new EntityNotFoundError(entityId)
  return parsed.data.kind
}

export async function entityAccessRecord(
  transaction: TransactionSql,
  call: CommandCall,
  accessRevision: AccessRevision,
): Promise<MutationRecord> {
  const { entityId, revision, kind } = accessRevision
  switch (kind) {
    case "work_item": {
      await transaction`update work_items set revision=${revision},updated_at=clock_timestamp()
        where id=${entityId}`
      await appendLegacyRevision(transaction, entityId)
      return record({
        entityId,
        revision,
        kind,
        schemaVersion: "work-item.r4.v1",
        snapshot: await workSnapshot(transaction, entityId),
        postEvent: async (eventId, occurredAt) =>
          appendLegacyEvent(transaction, call, entityId, revision, eventId, occurredAt, []),
      })
    }
    case "project":
      await transaction`update projects set revision=${revision},updated_at=clock_timestamp() where id=${entityId}`
      return record({
        kind,
        entityId,
        revision,
        schemaVersion: "project.r4.v1",
        snapshot: await projectSnapshot(transaction, entityId),
      })
    case "space":
      await transaction`update spaces s set updated_at=clock_timestamp() from entities e
        where e.id=${entityId} and s.workspace_id=e.workspace_id and s.id=e.scope_space_id`
      return record({
        kind,
        entityId,
        revision,
        schemaVersion: "space.r4.v1",
        snapshot: await spaceSnapshot(
          transaction,
          call.workspaceId,
          await spaceLocalId(transaction, entityId),
        ),
      })
    case "workflow":
      await transaction`update workflows set revision=${revision} where id=${entityId}`
      return record({
        kind,
        entityId,
        revision,
        schemaVersion: "workflow.r4.v1",
        snapshot: await tableSnapshot(transaction, "workflows", entityId),
      })
    case "workflow_state":
      await transaction`update workflow_states set revision=${revision} where id=${entityId}`
      return record({
        kind,
        entityId,
        revision,
        schemaVersion: "workflow_state.r4.v1",
        snapshot: await tableSnapshot(transaction, "workflow_states", entityId),
      })
    case "label":
      await transaction`update labels set revision=${revision} where id=${entityId}`
      return record({
        kind,
        entityId,
        revision,
        schemaVersion: "label.r4.v1",
        snapshot: await tableSnapshot(transaction, "labels", entityId),
      })
    case "relation":
      await transaction`update relations set revision=${revision} where id=${entityId}`
      return record({
        kind,
        entityId,
        revision,
        schemaVersion: "relation.r4.v1",
        snapshot: await tableSnapshot(transaction, "relations", entityId),
      })
    case "thread":
      await transaction`update threads set revision=${revision} where id=${entityId}`
      return record({
        kind,
        entityId,
        revision,
        schemaVersion: "thread.r4.v1",
        snapshot: await tableSnapshot(transaction, "threads", entityId),
      })
    case "comment":
      await transaction`update comments set revision=${revision},updated_at=clock_timestamp() where id=${entityId}`
      return record({
        kind,
        entityId,
        revision,
        schemaVersion: "comment.r4.v1",
        snapshot: await tableSnapshot(transaction, "comments", entityId),
      })
    case "saved_view":
      await transaction`update saved_views set revision=${revision} where id=${entityId}`
      return record({
        kind,
        entityId,
        revision,
        schemaVersion: "saved-view.r4.v1",
        snapshot: await tableSnapshot(transaction, "saved_views", entityId),
      })
    default:
      return assertNever(kind)
  }
}

async function spaceLocalId(transaction: TransactionSql, entityId: string): Promise<string> {
  const rows = await transaction<{ readonly scope_space_id: string }[]>`
    select scope_space_id from entities where id=${entityId}`
  const spaceId = rows[0]?.scope_space_id
  if (spaceId === undefined) throw new EntityNotFoundError(entityId)
  return spaceId
}

function record(input: AccessRecord): MutationRecord {
  return {
    entityId: input.entityId,
    kind: input.kind,
    revision: input.revision,
    schemaVersion: input.schemaVersion,
    eventType: "acl.changed",
    snapshot: input.snapshot,
    eventData: { id: input.entityId },
    result: { id: input.entityId },
    ...(input.postEvent === undefined ? {} : { postEvent: input.postEvent }),
  }
}

function assertNever(value: never): never {
  throw new CommandInvariantError(`unsupported_access_entity_kind:${value}`)
}

async function tableSnapshot(
  transaction: TransactionSql,
  table:
    | "workflows"
    | "workflow_states"
    | "labels"
    | "relations"
    | "threads"
    | "comments"
    | "saved_views",
  entityId: string,
): Promise<JsonObject> {
  const rows = await transaction.unsafe(`select to_jsonb(t) snapshot from ${table} t where id=$1`, [
    entityId,
  ])
  const row = rows[0]
  if (row === undefined) throw new EntityNotFoundError(entityId)
  return SnapshotSchema.parse(row).snapshot
}
