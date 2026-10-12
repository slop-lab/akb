import type { TransactionSql } from "postgres"
import type { AuthenticatedPrincipal, WorkPermission } from "../identity/types.ts"

export async function hasCurrentSavedViewSpaceAuthority(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  viewId: string,
  permission: WorkPermission,
): Promise<boolean> {
  const rows = await transaction`select 1 from saved_views v
    where v.workspace_id=${principal.workspaceId} and v.id=${viewId}
      and (v.scope_space_id is null or entity_access_allowed(v.workspace_id,
        stable_space_entity_id(v.workspace_id,v.scope_space_id),
         ${principal.principalId},${permission})) for share of v`
  return rows.length === 1
}

export async function hasSpaceAuthority(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  spaceId: string,
  permission: WorkPermission,
): Promise<boolean> {
  const rows = await transaction<{ readonly allowed: boolean }[]>`
    select entity_access_allowed(${principal.workspaceId},
    stable_space_entity_id(${principal.workspaceId},${spaceId}),
    ${principal.principalId},${permission}) allowed`
  return rows[0]?.allowed === true
}
