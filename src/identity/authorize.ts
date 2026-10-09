import type { TransactionSql } from "postgres"
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
  WorkspaceNotFoundError,
} from "./authorization-errors.ts"
import { lockAuthenticatedPrincipal } from "./authenticate.ts"
import type { AuthenticatedPrincipal, WorkPermission } from "./types.ts"

export async function authorizeWorkspace(
  transaction: TransactionSql,
  context: AuthenticatedPrincipal,
  permission: WorkPermission,
  workspaceId: string,
): Promise<void> {
  if (!(await lockAuthenticatedPrincipal(transaction, context))) {
    throw new AuthenticationRequiredError()
  }
  if (workspaceId !== context.workspaceId) throw new WorkspaceNotFoundError()
  const rows = await transaction`select permission from membership_permissions
    where workspace_id = ${context.workspaceId} and principal_id = ${context.principalId}
      and permission = ${permission} for share`
  if (rows.length !== 1) throw new PermissionDeniedError()
}

export async function requireWorkspaceGrant(
  transaction: TransactionSql,
  context: AuthenticatedPrincipal,
  permission: WorkPermission,
): Promise<void> {
  const rows = await transaction`select permission from membership_permissions
    where workspace_id = ${context.workspaceId} and principal_id = ${context.principalId}
      and permission = ${permission} for share`
  if (rows.length !== 1) throw new PermissionDeniedError()
}
