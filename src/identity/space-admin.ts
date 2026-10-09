import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import { SpaceIdSchema } from "../work-items/identifiers.ts"
import { IdentityNotActiveError } from "./admin-errors.ts"
import { IdentityWorkspaceIdSchema, PrincipalIdSchema, WorkPermissionSchema } from "./types.ts"

export const CreateSpaceSchema = z.strictObject({
  workspaceId: IdentityWorkspaceIdSchema,
  spaceId: SpaceIdSchema,
  spaceName: z.string().trim().min(1).max(200),
  visibility: z.enum(["public", "private"]),
})
export const SetSpaceVisibilitySchema = z.strictObject({
  workspaceId: IdentityWorkspaceIdSchema,
  spaceId: SpaceIdSchema,
  visibility: z.enum(["public", "private"]),
})
export const SetSpacePermissionsSchema = z.strictObject({
  workspaceId: IdentityWorkspaceIdSchema,
  spaceId: SpaceIdSchema,
  principalId: PrincipalIdSchema,
  permissions: z.array(WorkPermissionSchema),
})

export class SpaceAdmin {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  async create(input: z.input<typeof CreateSpaceSchema>): Promise<void> {
    const value = CreateSpaceSchema.parse(input)
    await this.#sql.begin(async (transaction) => {
      await lockWorkspace(transaction, value.workspaceId)
      await transaction`insert into spaces (workspace_id, id, name, visibility)
        values (${value.workspaceId}, ${value.spaceId}, ${value.spaceName}, ${value.visibility})`
    })
  }

  async setVisibility(input: z.input<typeof SetSpaceVisibilitySchema>): Promise<void> {
    const value = SetSpaceVisibilitySchema.parse(input)
    await this.#sql.begin(async (transaction) => {
      await lockWorkspace(transaction, value.workspaceId)
      const rows = await transaction`update spaces set visibility = ${value.visibility},
        updated_at = clock_timestamp() where workspace_id = ${value.workspaceId}
        and id = ${value.spaceId} returning id`
      if (rows.length !== 1) throw new IdentityNotActiveError()
    })
  }

  async setPermissions(input: z.input<typeof SetSpacePermissionsSchema>): Promise<void> {
    const value = SetSpacePermissionsSchema.parse(input)
    await this.#sql.begin(async (transaction) => {
      await lockWorkspace(transaction, value.workspaceId)
      const spaces =
        await transaction`select id from spaces where workspace_id = ${value.workspaceId}
        and id = ${value.spaceId} for update`
      if (spaces.length !== 1) throw new IdentityNotActiveError()
      const principals = await transaction`select p.id from principals p
        join workspace_memberships m on m.workspace_id = p.workspace_id and m.principal_id = p.id
        where p.workspace_id = ${value.workspaceId} and p.id = ${value.principalId}
          and p.status = 'active' and m.status = 'active' for update of p, m`
      if (principals.length !== 1) throw new IdentityNotActiveError()
      await transaction`delete from space_permissions where workspace_id = ${value.workspaceId}
        and space_id = ${value.spaceId} and principal_id = ${value.principalId}`
      for (const permission of new Set(value.permissions)) {
        await transaction`insert into space_permissions
          (workspace_id, space_id, principal_id, permission)
          values (${value.workspaceId}, ${value.spaceId}, ${value.principalId}, ${permission})`
      }
    })
  }
}

async function lockWorkspace(transaction: TransactionSql, workspaceId: string): Promise<void> {
  const rows = await transaction`select id from workspaces where id = ${workspaceId}
    and status = 'active' for update`
  if (rows.length !== 1) throw new IdentityNotActiveError()
}
