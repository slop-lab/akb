import { createHash, randomUUID } from "node:crypto"
import type { TransactionSql } from "postgres"
import { z } from "zod"
import { type WorkPermission, WorkPermissionSchema } from "../identity/types.ts"

const ReadPermissionRowSchema = z.strictObject({ read_permission: z.string() })

export type EntityRegistration = {
  readonly id: string
  readonly workspaceId: string
  readonly kind: string
  readonly scopeSpaceId: string | null
  readonly actorId: string
}

export function newEntityId(kind: string): string {
  return `${kind}:${randomUUID()}`
}

export function stableEntityId(kind: string, workspaceId: string, localId: string): string {
  const source = `${Array.from(workspaceId).length}:${workspaceId}${localId}`
  return `${kind}:${createHash("sha256").update(source).digest("hex")}`
}

export async function insertEntity(
  transaction: TransactionSql,
  registration: EntityRegistration,
): Promise<void> {
  await transaction`insert into entities
    (id, workspace_id, kind, scope_space_id, current_revision, created_by, created_at, updated_at)
    values (${registration.id}, ${registration.workspaceId}, ${registration.kind},
      ${registration.scopeSpaceId}, 1, ${registration.actorId}, clock_timestamp(), clock_timestamp())`
  await transaction`insert into entity_acl_policies values (${registration.id}, 'inherit')`
}

export async function linkEntityAccessDependency(
  transaction: TransactionSql,
  entityId: string,
  requiredEntityId: string,
): Promise<void> {
  await transaction`insert into entity_access_dependencies (entity_id, required_entity_id)
    values (${entityId}, ${requiredEntityId}) on conflict do nothing`
}

export async function registeredEntityReadPermission(
  transaction: TransactionSql,
  kind: string,
): Promise<WorkPermission | null> {
  const rows =
    await transaction`select read_permission from entity_kind_registry where kind=${kind}`
  const row = rows[0]
  if (row === undefined) return null
  return WorkPermissionSchema.parse(ReadPermissionRowSchema.parse(row).read_permission)
}
