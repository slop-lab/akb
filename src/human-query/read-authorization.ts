import type { TransactionSql } from "postgres"
import { entityReadPermission } from "../entities/read-permission.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import { AuthenticationRequiredError } from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal, WorkPermission } from "../identity/types.ts"

export async function lockReadPrincipal(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
): Promise<void> {
  if (!(await lockAuthenticatedPrincipal(transaction, principal))) {
    throw new AuthenticationRequiredError()
  }
}

export async function canReadEntity(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  id: string,
): Promise<boolean> {
  const rows = await transaction<{ readonly kind: string }[]>`
    select kind from entities where workspace_id=${principal.workspaceId} and id=${id}`
  const kind = rows[0]?.kind
  if (kind === undefined) return false
  const permission = entityReadPermission(kind)
  if (permission === null) return false
  const allowed = await transaction<{ readonly allowed: boolean }[]>`
    select entity_access_allowed(${principal.workspaceId},${id},${principal.principalId},
      ${permission}) allowed`
  return allowed[0]?.allowed === true
}

export async function hasPermission(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  permission: WorkPermission,
): Promise<boolean> {
  const rows = await transaction`select 1 from membership_permissions
    where workspace_id=${principal.workspaceId} and principal_id=${principal.principalId}
      and permission=${permission}`
  return rows.length === 1
}
