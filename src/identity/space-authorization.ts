import type { TransactionSql } from "postgres"
import { z } from "zod"
import { SpaceIdSchema, type SpaceId } from "../work-items/identifiers.ts"
import { PermissionDeniedError, SpaceNotFoundError } from "./authorization-errors.ts"
import type { AuthenticatedPrincipal, WorkPermission } from "./types.ts"

const VisibilitySchema = z.strictObject({ visibility: z.enum(["public", "private"]) })

export async function requireSpacePermissions(
  transaction: TransactionSql,
  context: AuthenticatedPrincipal,
  spaceId: SpaceId,
  permissions: readonly WorkPermission[],
  inaccessibleAsNotFound = false,
): Promise<void> {
  const spaces = await transaction`select visibility from spaces
    where workspace_id = ${context.workspaceId} and id = ${spaceId} for share`
  const space = spaces[0]
  if (space === undefined) throw new SpaceNotFoundError()
  if (VisibilitySchema.parse(space).visibility === "public") return
  const grants = await transaction<{ readonly permission: WorkPermission }[]>`
    select permission from space_permissions where workspace_id = ${context.workspaceId}
      and space_id = ${spaceId} and principal_id = ${context.principalId}
      and permission in ${transaction(permissions)} for share`
  const granted = new Set(grants.map((grant) => grant.permission))
  if (permissions.every((permission) => granted.has(permission))) return
  if (inaccessibleAsNotFound) throw new SpaceNotFoundError()
  throw new PermissionDeniedError()
}

export async function accessibleSpaceIds(
  transaction: TransactionSql,
  context: AuthenticatedPrincipal,
  permission: WorkPermission,
): Promise<readonly SpaceId[]> {
  const rows = await transaction<{ readonly id: unknown }[]>`select s.id from spaces s
    where s.workspace_id = ${context.workspaceId} and (
      s.visibility = 'public' or exists (
        select 1 from space_permissions sp where sp.workspace_id = s.workspace_id
          and sp.space_id = s.id and sp.principal_id = ${context.principalId}
          and sp.permission = ${permission}
      )
    ) order by s.id for share of s`
  return Object.freeze(rows.map((row) => SpaceIdSchema.parse(row.id)))
}

export async function requireCompletePrivateSpaceRead(
  transaction: TransactionSql,
  context: AuthenticatedPrincipal,
): Promise<readonly SpaceId[]> {
  const accessible = await accessibleSpaceIds(transaction, context, "work.read")
  const denied =
    await transaction`select 1 from spaces s where s.workspace_id = ${context.workspaceId}
    and s.visibility = 'private' and not exists (
      select 1 from space_permissions sp where sp.workspace_id = s.workspace_id
        and sp.space_id = s.id and sp.principal_id = ${context.principalId}
        and sp.permission = 'work.read'
    ) limit 1`
  if (denied.length > 0) throw new PermissionDeniedError()
  return accessible
}
