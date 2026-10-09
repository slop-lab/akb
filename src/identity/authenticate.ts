import { createHash } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import {
  CredentialIdSchema,
  IdentityWorkspaceIdSchema,
  PrincipalIdSchema,
  type AuthenticatedPrincipal,
} from "./types.ts"

export const BearerTokenSchema = z.string().regex(/^afw_[A-Za-z0-9_-]{43}$/)
const AuthenticationRowSchema = z.strictObject({
  credential_id: CredentialIdSchema,
  principal_id: PrincipalIdSchema,
  workspace_id: IdentityWorkspaceIdSchema,
})

export async function authenticateToken(
  sql: Sql,
  token: string,
): Promise<AuthenticatedPrincipal | undefined> {
  if (!BearerTokenSchema.safeParse(token).success) return undefined
  const rows = await sql`
    select c.id as credential_id, c.principal_id, c.workspace_id
    from principal_credentials c
    join principals p on p.id = c.principal_id and p.workspace_id = c.workspace_id
    join workspaces w on w.id = c.workspace_id
    join workspace_memberships m
      on m.workspace_id = c.workspace_id and m.principal_id = c.principal_id
    where c.token_hash = ${createHash("sha256").update(token).digest()}
      and c.revoked_at is null and c.expires_at > clock_timestamp()
      and p.status = 'active' and w.status = 'active' and m.status = 'active'
  `
  if (rows[0] === undefined) return undefined
  const row = AuthenticationRowSchema.parse(rows[0])
  return {
    credentialId: row.credential_id,
    principalId: row.principal_id,
    workspaceId: row.workspace_id,
  }
}

export async function lockAuthenticatedPrincipal(
  transaction: TransactionSql,
  context: AuthenticatedPrincipal,
): Promise<boolean> {
  const lockedRows = await transaction`
    select c.id
    from workspaces w
    join principals p on p.workspace_id = w.id
    join workspace_memberships m on m.workspace_id = p.workspace_id and m.principal_id = p.id
    join principal_credentials c on c.workspace_id = p.workspace_id and c.principal_id = p.id
    where w.id = ${context.workspaceId} and p.id = ${context.principalId} and c.id = ${context.credentialId}
    for update of w, p, m, c
  `
  if (lockedRows.length !== 1) return false
  const validityRows = await transaction<{ readonly valid: boolean }[]>`
    select exists (
      select 1 from workspaces w
      join principals p on p.workspace_id = w.id
      join workspace_memberships m on m.workspace_id = p.workspace_id and m.principal_id = p.id
      join principal_credentials c on c.workspace_id = p.workspace_id and c.principal_id = p.id
      where w.id = ${context.workspaceId} and p.id = ${context.principalId}
        and c.id = ${context.credentialId} and w.status = 'active'
        and p.status = 'active' and m.status = 'active' and c.revoked_at is null
        and c.expires_at > clock_timestamp()
    ) as valid`
  return validityRows[0]?.valid === true
}
