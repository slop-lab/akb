import type { TransactionSql } from "postgres"
import { z } from "zod"
import { EntityNotFoundError } from "../entities/errors.ts"
import {
  type AuthenticatedPrincipal,
  CredentialIdSchema,
  IdentityWorkspaceIdSchema,
  PrincipalIdSchema,
} from "../identity/types.ts"

const PrincipalRowSchema = z.strictObject({
  credential_id: CredentialIdSchema,
  principal_id: PrincipalIdSchema,
  workspace_id: IdentityWorkspaceIdSchema,
})

export async function resolveAutomationPrincipal(
  transaction: TransactionSql,
  workspaceId: string,
  principalId: string,
): Promise<AuthenticatedPrincipal> {
  const rows = await transaction`select credential.id credential_id,
    credential.principal_id,credential.workspace_id from principal_credentials credential
    join principals principal on principal.workspace_id=credential.workspace_id
      and principal.id=credential.principal_id
    join workspace_memberships membership on membership.workspace_id=credential.workspace_id
      and membership.principal_id=credential.principal_id
    where credential.workspace_id=${workspaceId} and credential.principal_id=${principalId}
      and credential.revoked_at is null and credential.expires_at>clock_timestamp()
      and principal.status='active' and membership.status='active'
    order by credential.expires_at desc,credential.id limit 1`
  const parsed = PrincipalRowSchema.safeParse(rows[0])
  if (!parsed.success) throw new EntityNotFoundError(principalId)
  return {
    credentialId: parsed.data.credential_id,
    principalId: parsed.data.principal_id,
    workspaceId: parsed.data.workspace_id,
  }
}
