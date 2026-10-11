import type { Sql } from "postgres"
import { z } from "zod"
import { WORK_PERMISSIONS } from "./types.ts"

const GrantSchema = z.strictObject({ workspaceId: z.string(), principalId: z.string() })
const AccessSchema = z.strictObject({
  workspaceId: z.string(),
  entityId: z.string(),
  mode: z.enum(["inherit", "restricted"]),
  principalId: z.string(),
  permissions: z.array(z.enum(WORK_PERMISSIONS)).readonly(),
})

export class R4Admin {
  readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  async grantPermissions(input: z.input<typeof GrantSchema>): Promise<void> {
    const value = GrantSchema.parse(input)
    await this.sql.begin(async (transaction) => {
      await transaction`select id from workspaces where id=${value.workspaceId} for update`
      const rows =
        await transaction`select 1 from workspace_memberships where workspace_id=${value.workspaceId}
        and principal_id=${value.principalId} and status='active' for update`
      if (rows.length !== 1) throw new R4AdminTargetError()
      for (const permission of WORK_PERMISSIONS) {
        await transaction`insert into membership_permissions (workspace_id,principal_id,permission)
          values (${value.workspaceId},${value.principalId},${permission}) on conflict do nothing`
      }
    })
  }

  async setEntityAccess(input: z.input<typeof AccessSchema>): Promise<void> {
    const value = AccessSchema.parse(input)
    await this.sql.begin(async (transaction) => {
      await transaction`select id from workspaces where id=${value.workspaceId} for update`
      const rows = await transaction`select id from entities where workspace_id=${value.workspaceId}
        and id=${value.entityId} for update`
      if (rows.length !== 1) throw new R4AdminTargetError()
      await transaction`update entity_acl_policies set mode=${value.mode} where entity_id=${value.entityId}`
      await transaction`delete from entity_acl_allowances where entity_id=${value.entityId}`
      if (value.mode === "restricted") {
        for (const permission of new Set(value.permissions)) {
          await transaction`insert into entity_acl_allowances (entity_id,principal_id,permission)
            values (${value.entityId},${value.principalId},${permission})`
        }
      }
    })
  }
}

export class R4AdminTargetError extends Error {
  override readonly name = "R4AdminTargetError"
  constructor() {
    super("R4 administrator target was not found")
  }
}
