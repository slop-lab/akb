import type { TransactionSql } from "postgres"
import { entityReadPermission } from "../entities/read-permission.ts"
import { hasCurrentSavedViewSpaceAuthority } from "../entities/saved-view-scope.ts"
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
  if (allowed[0]?.allowed !== true) return false
  switch (kind) {
    case "comment": {
      const [comment] = await transaction<{ readonly thread_id: string }[]>`
        select thread_id from comments where workspace_id=${principal.workspaceId} and id=${id}`
      return comment !== undefined && canReadEntity(transaction, principal, comment.thread_id)
    }
    case "thread": {
      const [thread] = await transaction<{ readonly subject_entity_id: string }[]>`
        select subject_entity_id from threads where workspace_id=${principal.workspaceId} and id=${id}`
      return thread !== undefined && canReadEntity(transaction, principal, thread.subject_entity_id)
    }
    case "relation": {
      const [relation] = await transaction<
        { readonly from_entity_id: string; readonly to_entity_id: string }[]
      >`select from_entity_id,to_entity_id from relations
        where workspace_id=${principal.workspaceId} and id=${id}`
      if (relation === undefined) return false
      const endpoints = await Promise.all([
        canReadEntity(transaction, principal, relation.from_entity_id),
        canReadEntity(transaction, principal, relation.to_entity_id),
      ])
      return endpoints.every(Boolean)
    }
    case "saved_view":
      return hasCurrentSavedViewSpaceAuthority(transaction, principal, id, "space.read")
    default:
      return true
  }
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
