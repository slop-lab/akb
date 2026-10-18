import { createHash } from "node:crypto"
import type { TransactionSql } from "postgres"
import { z } from "zod"
import type { JsonObject, MutationRecord } from "../entities/mutation-types.ts"

export function automationEntityId(kind: string, workspaceId: string, key: string): string {
  return `${kind}:${createHash("sha256").update(`${workspaceId}:${key}`).digest("hex")}`
}

export async function insertAutomationEntity(
  transaction: TransactionSql,
  input: {
    readonly id: string
    readonly workspaceId: string
    readonly kind: string
    readonly spaceId: string | null
    readonly actorId: string
  },
): Promise<void> {
  await transaction`insert into entities
    (id,workspace_id,kind,scope_space_id,current_revision,created_by,created_at,updated_at)
    values (${input.id},${input.workspaceId},${input.kind},${input.spaceId},1,${input.actorId},
      clock_timestamp(),clock_timestamp())`
  await transaction`insert into entity_acl_policies values (${input.id},'inherit')`
}

export async function addAutomationDependency(
  transaction: TransactionSql,
  entityId: string,
  requiredEntityId: string,
): Promise<void> {
  await transaction`insert into entity_access_dependencies values (${entityId},${requiredEntityId})`
}

export function automationRecord(input: {
  readonly id: string
  readonly kind: string
  readonly revision: number
  readonly snapshot: JsonObject
  readonly eventType?: MutationRecord["eventType"]
  readonly result?: JsonObject
  readonly postEvent?: MutationRecord["postEvent"]
}): MutationRecord {
  return {
    entityId: input.id,
    kind: input.kind,
    revision: input.revision,
    schemaVersion: `${input.kind}.automation.v1`,
    eventType: input.eventType ?? (input.revision === 1 ? "entity.created" : "entity.updated"),
    snapshot: input.snapshot,
    eventData: { id: input.id },
    result: input.result ?? { id: input.id },
    ...(input.postEvent === undefined ? {} : { postEvent: input.postEvent }),
  }
}

export function jsonRow(value: unknown): JsonObject {
  return z.record(z.string(), z.unknown()).parse(value)
}
