import { z } from "zod"
import { createPostgresClient, databaseUrlFromEnvironment } from "../postgres/client.ts"
import { IdentityAdmin } from "./admin.ts"
import { SpaceAdmin } from "./space-admin.ts"
import { runR4AdminCommand } from "./r4-admin-cli.ts"
import { MEMBERSHIP_ROLES, PRINCIPAL_KINDS, WORK_PERMISSIONS } from "./types.ts"

const HELP = `Usage: npm run admin -- <command> [options]

Commands:
  bootstrap-workspace --workspace-id ID --workspace-name NAME --principal-id ID --principal-name NAME [--expires-at ISO]
  provision-principal --workspace-id ID --principal-id ID --display-name NAME --kind KIND --role ROLE [--permissions CSV]
  set-permissions --workspace-id ID --principal-id ID [--permissions CSV]
  issue-token --workspace-id ID --principal-id ID [--expires-at ISO]
  revoke-token --credential-id ID
  create-space --workspace-id ID --space-id ID --space-name NAME --visibility public|private
  set-space-visibility --workspace-id ID --space-id ID --visibility public|private
  set-space-permissions --workspace-id ID --space-id ID --principal-id ID [--permissions CSV]
  grant-r4-permissions --workspace-id ID --principal-id ID
  set-entity-access --workspace-id ID --entity-id ID --mode inherit|restricted --principal-id ID [--permissions CSV]

Kinds: ${PRINCIPAL_KINDS.join(", ")}
Roles: ${MEMBERSHIP_ROLES.join(", ")}
Permissions: ${WORK_PERMISSIONS.join(", ")}`

const BaseOptionsSchema = z.record(z.string(), z.string())
const PermissionListSchema = z
  .string()
  .default("")
  .transform((value) => (value === "" ? [] : value.split(",")))
  .pipe(z.array(z.enum(WORK_PERMISSIONS)))
const FutureExpirySchema = z.iso.datetime().optional()

export async function runAdminCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") return HELP
  const command = z
    .enum([
      "bootstrap-workspace",
      "provision-principal",
      "set-permissions",
      "issue-token",
      "revoke-token",
      "create-space",
      "set-space-visibility",
      "set-space-permissions",
      "grant-r4-permissions",
      "set-entity-access",
    ])
    .parse(args[0])
  const options = parseOptions(args.slice(1))
  const sql = createPostgresClient(databaseUrlFromEnvironment(environment))
  const admin = new IdentityAdmin(sql)
  const spaces = new SpaceAdmin(sql)
  try {
    const r4Result = await runR4AdminCommand(command, options, sql)
    if (r4Result !== undefined) return r4Result
    switch (command) {
      case "bootstrap-workspace": {
        const value = z
          .strictObject({
            "workspace-id": z.string(),
            "workspace-name": z.string(),
            "principal-id": z.string(),
            "principal-name": z.string(),
            "expires-at": FutureExpirySchema,
          })
          .parse(options)
        const issued = await admin.bootstrapWorkspace({
          workspaceId: value["workspace-id"],
          workspaceName: value["workspace-name"],
          principalId: value["principal-id"],
          principalName: value["principal-name"],
          expiresAt: value["expires-at"] ?? defaultExpiry(),
        })
        return JSON.stringify(issued)
      }
      case "provision-principal": {
        const value = z
          .strictObject({
            "workspace-id": z.string(),
            "principal-id": z.string(),
            "display-name": z.string(),
            kind: z.enum(PRINCIPAL_KINDS),
            role: z.enum(MEMBERSHIP_ROLES),
            permissions: PermissionListSchema,
          })
          .parse(options)
        await admin.provisionPrincipal({
          workspaceId: value["workspace-id"],
          principalId: value["principal-id"],
          displayName: value["display-name"],
          kind: value.kind,
          role: value.role,
          permissions: value.permissions,
        })
        return JSON.stringify({ provisioned: value["principal-id"] })
      }
      case "set-permissions": {
        const value = z
          .strictObject({
            "workspace-id": z.string(),
            "principal-id": z.string(),
            permissions: PermissionListSchema,
          })
          .parse(options)
        await admin.setPermissions({
          workspaceId: value["workspace-id"],
          principalId: value["principal-id"],
          permissions: value.permissions,
        })
        return JSON.stringify({ updated: value["principal-id"] })
      }
      case "issue-token": {
        const value = z
          .strictObject({
            "workspace-id": z.string(),
            "principal-id": z.string(),
            "expires-at": FutureExpirySchema,
          })
          .parse(options)
        return JSON.stringify(
          await admin.issueToken({
            workspaceId: value["workspace-id"],
            principalId: value["principal-id"],
            expiresAt: value["expires-at"] ?? defaultExpiry(),
          }),
        )
      }
      case "revoke-token": {
        const value = z.strictObject({ "credential-id": z.string() }).parse(options)
        await admin.revokeToken({ credentialId: value["credential-id"] })
        return JSON.stringify({ revoked: value["credential-id"] })
      }
      case "create-space": {
        const value = z
          .strictObject({
            "workspace-id": z.string(),
            "space-id": z.string(),
            "space-name": z.string(),
            visibility: z.enum(["public", "private"]),
          })
          .parse(options)
        await spaces.create({
          workspaceId: value["workspace-id"],
          spaceId: value["space-id"],
          spaceName: value["space-name"],
          visibility: value.visibility,
        })
        return JSON.stringify({ created: value["space-id"] })
      }
      case "set-space-visibility": {
        const value = z
          .strictObject({
            "workspace-id": z.string(),
            "space-id": z.string(),
            visibility: z.enum(["public", "private"]),
          })
          .parse(options)
        await spaces.setVisibility({
          workspaceId: value["workspace-id"],
          spaceId: value["space-id"],
          visibility: value.visibility,
        })
        return JSON.stringify({ updated: value["space-id"] })
      }
      case "set-space-permissions": {
        const value = z
          .strictObject({
            "workspace-id": z.string(),
            "space-id": z.string(),
            "principal-id": z.string(),
            permissions: PermissionListSchema,
          })
          .parse(options)
        await spaces.setPermissions({
          workspaceId: value["workspace-id"],
          spaceId: value["space-id"],
          principalId: value["principal-id"],
          permissions: value.permissions,
        })
        return JSON.stringify({
          updated: value["space-id"],
          principalId: value["principal-id"],
        })
      }
      case "grant-r4-permissions":
      case "set-entity-access":
        throw new TypeError("R4 command dispatch failed")
      default:
        return assertNever(command)
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function parseOptions(args: readonly string[]): Readonly<Record<string, string>> {
  const options: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new TypeError("options must be --name value pairs")
    }
    options[flag.slice(2)] = value
  }
  return BaseOptionsSchema.parse(options)
}

function defaultExpiry(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString()
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected command: ${value}`)
}

export { HELP as ADMIN_HELP }
