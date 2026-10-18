import { createHash } from "node:crypto"
import type { TransactionSql } from "postgres"
import { z } from "zod"
import { CommandInvariantError, EntityNotFoundError } from "../entities/errors.ts"
import type { JsonObject, MutationRecord } from "../entities/mutation-types.ts"
import type { WorkPermission } from "../identity/types.ts"

export function stablePlanningEntityId(kind: string, workspaceId: string, localId: string): string {
  return `${kind}:${createHash("sha256").update(`${workspaceId}:${localId}`).digest("hex")}`
}

export async function insertPlanningEntity(
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

export async function requireAccess(
  transaction: TransactionSql,
  input: {
    readonly workspaceId: string
    readonly principalId: string
    readonly entityId: string
    readonly permission: WorkPermission
  },
): Promise<void> {
  const rows = await transaction`select 1 where entity_access_allowed(${input.workspaceId},
    ${input.entityId},${input.principalId},${input.permission})`
  if (rows.length !== 1) throw new EntityNotFoundError(input.entityId)
}

export async function addDependency(
  transaction: TransactionSql,
  entityId: string,
  requiredEntityId: string,
): Promise<void> {
  await transaction`insert into entity_access_dependencies values (${entityId},${requiredEntityId})`
}

export function planningRecord(input: {
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
    schemaVersion: `${input.kind}.planning.v1`,
    eventType: input.eventType ?? (input.revision === 1 ? "entity.created" : "entity.updated"),
    snapshot: input.snapshot,
    eventData: { id: input.id },
    result: input.result ?? { id: input.id },
    ...(input.postEvent === undefined ? {} : { postEvent: input.postEvent }),
  }
}

export function targetRevision(
  targets: ReadonlyMap<string, { readonly nextRevision: number }>,
  entityId: string,
): number {
  const revision = targets.get(entityId)?.nextRevision
  if (revision === undefined) throw new CommandInvariantError("planning_target_not_locked")
  return revision
}

export function rowObject(value: unknown): JsonObject {
  return z.record(z.string(), z.unknown()).parse(value)
}
