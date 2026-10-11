import type { Sql } from "postgres"
import { z } from "zod"
import { R4Admin } from "./r4-admin.ts"
import { WORK_PERMISSIONS } from "./types.ts"

const PermissionListSchema = z
  .string()
  .transform((value) => (value === "" ? [] : value.split(",")))
  .pipe(z.array(z.enum(WORK_PERMISSIONS)))

export async function runR4AdminCommand(
  command: string,
  options: Readonly<Record<string, string>>,
  sql: Sql,
): Promise<string | undefined> {
  const admin = new R4Admin(sql)
  if (command === "grant-r4-permissions") {
    const value = z
      .strictObject({ "workspace-id": z.string(), "principal-id": z.string() })
      .parse(options)
    await admin.grantPermissions({
      workspaceId: value["workspace-id"],
      principalId: value["principal-id"],
    })
    return JSON.stringify({ granted: value["principal-id"] })
  }
  if (command === "set-entity-access") {
    const value = z
      .strictObject({
        "workspace-id": z.string(),
        "entity-id": z.string(),
        mode: z.enum(["inherit", "restricted"]),
        "principal-id": z.string(),
        permissions: PermissionListSchema,
      })
      .parse(options)
    await admin.setEntityAccess({
      workspaceId: value["workspace-id"],
      entityId: value["entity-id"],
      mode: value.mode,
      principalId: value["principal-id"],
      permissions: value.permissions,
    })
    return JSON.stringify({ updated: value["entity-id"] })
  }
  return undefined
}
