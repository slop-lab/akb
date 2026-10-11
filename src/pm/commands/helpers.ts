import { createHash, randomUUID } from "node:crypto"
import type { TransactionSql } from "postgres"
import { z } from "zod"
import { CommandInvariantError, EntityNotFoundError } from "../../entities/errors.ts"
import type { JsonObject } from "../../entities/mutation-types.ts"
import { entityReadPermission } from "../../entities/read-permission.ts"
import type { AuthenticatedPrincipal } from "../../identity/types.ts"

export const RecordSchema = z.record(z.string(), z.unknown())

export function newEntityId(kind: string): string {
  return `${kind}:${randomUUID()}`
}

export function stableEntityId(kind: string, workspaceId: string, localId: string): string {
  const source = `${Array.from(workspaceId).length}:${workspaceId}${localId}`
  return `${kind}:${createHash("sha256").update(source).digest("hex")}`
}

export async function insertEntity(
  transaction: TransactionSql,
  input: {
    readonly id: string
    readonly workspaceId: string
    readonly kind: string
    readonly scopeSpaceId: string | null
    readonly actorId: string
  },
): Promise<void> {
  await transaction`insert into entities
    (id, workspace_id, kind, scope_space_id, current_revision, created_by, created_at, updated_at)
    values (${input.id}, ${input.workspaceId}, ${input.kind}, ${input.scopeSpaceId}, 1,
      ${input.actorId}, clock_timestamp(), clock_timestamp())`
  await transaction`insert into entity_acl_policies values (${input.id}, 'inherit')`
}

export async function requireActiveHuman(
  transaction: TransactionSql,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  const rows = await transaction`select 1 from principals p join workspace_memberships m
    on m.workspace_id = p.workspace_id and m.principal_id = p.id
    where p.workspace_id = ${workspaceId} and p.id = ${principalId} and p.kind = 'human'
      and p.status = 'active' and m.status = 'active'`
  if (rows.length !== 1) throw new CommandInvariantError("active_human_required")
}

export function requireDateOrder(
  start: string | null,
  end: string | null,
  code: "project_date_order_invalid" | "work_item_date_order_invalid",
): void {
  if (start !== null && end !== null && start > end) throw new CommandInvariantError(code)
}

export async function requireSpaceAccess(
  transaction: TransactionSql,
  input: {
    readonly principal: AuthenticatedPrincipal
    readonly spaceId: string
    readonly permission: string
  },
): Promise<void> {
  const entityId = stableEntityId("space", input.principal.workspaceId, input.spaceId)
  const rows =
    await transaction`select 1 where entity_access_allowed(${input.principal.workspaceId},
    ${entityId},${input.principal.principalId},${input.permission})`
  if (rows.length !== 1) throw new EntityNotFoundError(entityId)
}

export async function requireEntityRead(
  transaction: TransactionSql,
  input: {
    readonly workspaceId: string
    readonly principalId: string
    readonly entityId: string
    readonly kinds: readonly string[]
    readonly scopeSpaceId?: string
  },
): Promise<string | null> {
  const rows = await transaction<
    { readonly kind: string; readonly scope_space_id: string | null }[]
  >`
    select kind,scope_space_id from entities where workspace_id=${input.workspaceId}
      and id=${input.entityId} and kind=any(${transaction.array([...input.kinds])})
      and (${input.scopeSpaceId ?? null}::text is null or scope_space_id=${input.scopeSpaceId ?? null})`
  const row = rows[0]
  const permission = row === undefined ? null : entityReadPermission(row.kind)
  if (row === undefined || permission === null) throw new EntityNotFoundError(input.entityId)
  const access = await transaction`select 1 where entity_access_allowed(${input.workspaceId},
    ${input.entityId},${input.principalId},${permission})`
  if (access.length !== 1) throw new EntityNotFoundError(input.entityId)
  return row.scope_space_id
}

export function json(value: Readonly<Record<string, unknown>>): JsonObject {
  return value
}
