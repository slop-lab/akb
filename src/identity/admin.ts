import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import {
  CredentialExpiryError,
  CredentialNotFoundError,
  IdentityNotActiveError,
} from "./admin-errors.ts"
import {
  CredentialIdSchema,
  IdentityWorkspaceIdSchema,
  MembershipRoleSchema,
  PrincipalIdSchema,
  PrincipalKindSchema,
  WorkPermissionSchema,
  type CredentialId,
  type WorkPermission,
} from "./types.ts"

export const BootstrapWorkspaceSchema = z.strictObject({
  workspaceId: IdentityWorkspaceIdSchema,
  workspaceName: z.string().trim().min(1).max(200),
  principalId: PrincipalIdSchema,
  principalName: z.string().trim().min(1).max(200),
  expiresAt: z.iso.datetime(),
})
export const ProvisionPrincipalSchema = z.strictObject({
  workspaceId: IdentityWorkspaceIdSchema,
  principalId: PrincipalIdSchema,
  displayName: z.string().trim().min(1).max(200),
  kind: PrincipalKindSchema,
  role: MembershipRoleSchema,
  permissions: z.array(WorkPermissionSchema),
})
export const SetPermissionsSchema = z.strictObject({
  workspaceId: IdentityWorkspaceIdSchema,
  principalId: PrincipalIdSchema,
  permissions: z.array(WorkPermissionSchema),
})
export const IssueTokenSchema = z.strictObject({
  workspaceId: IdentityWorkspaceIdSchema,
  principalId: PrincipalIdSchema,
  expiresAt: z.iso.datetime(),
})
export const RevokeTokenSchema = z.strictObject({ credentialId: CredentialIdSchema })

export type IssuedCredential = {
  readonly credentialId: CredentialId
  readonly token: string
  readonly expiresAt: string
}

export class IdentityAdmin {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  async bootstrapWorkspace(
    input: z.input<typeof BootstrapWorkspaceSchema>,
  ): Promise<IssuedCredential> {
    const value = BootstrapWorkspaceSchema.parse(input)
    return this.#sql.begin(async (transaction) => {
      await transaction`insert into workspaces (id, name) values (${value.workspaceId}, ${value.workspaceName})`
      await transaction`insert into principals (id, workspace_id, display_name, kind)
        values (${value.principalId}, ${value.workspaceId}, ${value.principalName}, 'human')`
      await transaction`insert into workspace_memberships (workspace_id, principal_id, role)
        values (${value.workspaceId}, ${value.principalId}, 'owner')`
      await replacePermissions(transaction, value.workspaceId, value.principalId, [
        "work.read",
        "work.create",
        "work.update",
        "work.assign",
      ])
      return issueCredential(transaction, value.workspaceId, value.principalId, value.expiresAt)
    })
  }

  async provisionPrincipal(input: z.input<typeof ProvisionPrincipalSchema>): Promise<void> {
    const value = ProvisionPrincipalSchema.parse(input)
    await this.#sql.begin(async (transaction) => {
      await lockWorkspace(transaction, value.workspaceId)
      await transaction`insert into principals (id, workspace_id, display_name, kind)
        values (${value.principalId}, ${value.workspaceId}, ${value.displayName}, ${value.kind})`
      await transaction`insert into workspace_memberships (workspace_id, principal_id, role)
        values (${value.workspaceId}, ${value.principalId}, ${value.role})`
      await replacePermissions(transaction, value.workspaceId, value.principalId, value.permissions)
    })
  }

  async setPermissions(input: z.input<typeof SetPermissionsSchema>): Promise<void> {
    const value = SetPermissionsSchema.parse(input)
    await this.#sql.begin(async (transaction) => {
      await lockAuthority(transaction, value.workspaceId, value.principalId)
      await replacePermissions(transaction, value.workspaceId, value.principalId, value.permissions)
    })
  }

  async issueToken(input: z.input<typeof IssueTokenSchema>): Promise<IssuedCredential> {
    const value = IssueTokenSchema.parse(input)
    return this.#sql.begin(async (transaction) => {
      const rows = await lockAuthority(transaction, value.workspaceId, value.principalId)
      const kind = z.enum(["human", "agent", "service", "runtime"]).parse(rows[0]?.kind)
      if (kind === "runtime") throw new RuntimeCredentialRejectedError(value.principalId)
      return issueCredential(transaction, value.workspaceId, value.principalId, value.expiresAt)
    })
  }

  async revokeToken(input: z.input<typeof RevokeTokenSchema>): Promise<void> {
    const value = RevokeTokenSchema.parse(input)
    await this.#sql.begin(async (transaction) => {
      const rows = await transaction`select workspace_id, principal_id from principal_credentials
        where id = ${value.credentialId}`
      if (rows[0] === undefined) throw new CredentialNotFoundError()
      const row = z
        .object({ workspace_id: IdentityWorkspaceIdSchema, principal_id: PrincipalIdSchema })
        .parse(rows[0])
      await lockIdentityForRevocation(transaction, row.workspace_id, row.principal_id)
      const credentialRows = await transaction`select id from principal_credentials
        where id = ${value.credentialId} and workspace_id = ${row.workspace_id}
          and principal_id = ${row.principal_id} for update`
      if (credentialRows.length !== 1) throw new CredentialNotFoundError()
      await transaction`update principal_credentials set revoked_at = now()
        where id = ${value.credentialId} and revoked_at is null`
    })
  }
}

export class RuntimeCredentialRejectedError extends Error {
  override readonly name = "RuntimeCredentialRejectedError"
  readonly principalId: string

  constructor(principalId: string) {
    super(`runtime principal ${principalId} cannot receive a workspace credential`)
    this.principalId = principalId
  }
}

async function lockWorkspace(transaction: TransactionSql, workspaceId: string): Promise<void> {
  const rows = await transaction`
    select id from workspaces where id = ${workspaceId} and status = 'active' for update`
  if (rows.length !== 1) throw new IdentityNotActiveError()
}

async function lockAuthority(
  transaction: TransactionSql,
  workspaceId: string,
  principalId: string,
): Promise<readonly { readonly kind: unknown }[]> {
  await lockWorkspace(transaction, workspaceId)
  const rows = await transaction<{ readonly kind: unknown }[]>`select p.kind from principals p
    join workspace_memberships m on m.workspace_id = p.workspace_id and m.principal_id = p.id
    where p.workspace_id = ${workspaceId} and p.id = ${principalId}
      and p.status = 'active' and m.status = 'active'
    for update of p, m`
  if (rows.length !== 1) throw new IdentityNotActiveError()
  return rows
}

async function lockIdentityForRevocation(
  transaction: TransactionSql,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  const workspaces = await transaction`select id from workspaces
    where id = ${workspaceId} for update`
  const principals = await transaction`select id from principals
    where workspace_id = ${workspaceId} and id = ${principalId} for update`
  const memberships = await transaction`select principal_id from workspace_memberships
    where workspace_id = ${workspaceId} and principal_id = ${principalId} for update`
  if (workspaces.length !== 1 || principals.length !== 1 || memberships.length !== 1) {
    throw new CredentialNotFoundError()
  }
}

async function replacePermissions(
  transaction: TransactionSql,
  workspaceId: string,
  principalId: string,
  permissions: readonly WorkPermission[],
): Promise<void> {
  await transaction`delete from membership_permissions
    where workspace_id = ${workspaceId} and principal_id = ${principalId}`
  for (const permission of new Set(permissions)) {
    await transaction`insert into membership_permissions (workspace_id, principal_id, permission)
      values (${workspaceId}, ${principalId}, ${permission})`
  }
}

async function issueCredential(
  transaction: TransactionSql,
  workspaceId: string,
  principalId: string,
  expiresAt: string,
): Promise<IssuedCredential> {
  const expiryRows = await transaction<{ readonly valid: boolean }[]>`
    select ${expiresAt}::timestamptz > clock_timestamp() as valid`
  if (expiryRows[0]?.valid !== true) throw new CredentialExpiryError()
  const token = `afw_${randomBytes(32).toString("base64url")}`
  const credentialId = CredentialIdSchema.parse(randomUUID())
  const tokenHash = createHash("sha256").update(token).digest()
  await transaction`insert into principal_credentials
    (id, workspace_id, principal_id, token_hash, expires_at)
    values (${credentialId}, ${workspaceId}, ${principalId}, ${tokenHash}, ${expiresAt})`
  return { credentialId, token, expiresAt }
}

export { CredentialExpiryError, CredentialNotFoundError, IdentityNotActiveError }
