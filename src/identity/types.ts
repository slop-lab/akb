import { z } from "zod"
import { ActorIdSchema, RawEventIdSchema, WorkspaceIdSchema } from "../work-items/identifiers.ts"

export const IdentityWorkspaceIdSchema = WorkspaceIdSchema
export const PrincipalIdSchema = ActorIdSchema
export const CredentialIdSchema = RawEventIdSchema.transform((value) => value.trim()).brand(
  "CredentialId",
)
export const PRINCIPAL_KINDS = ["human", "agent", "service", "runtime"] as const
export const MEMBERSHIP_ROLES = ["owner", "admin", "member", "guest"] as const
export const WORK_PERMISSIONS = [
  "work.read",
  "work.create",
  "work.update",
  "work.assign",
  "space.read",
  "space.manage",
  "project.read",
  "project.manage",
  "comment.create",
  "comment.update",
  "relation.manage",
  "view.read",
  "view.manage",
  "history.read",
  "acl.manage",
] as const
export const PrincipalKindSchema = z.enum(PRINCIPAL_KINDS)
export const MembershipRoleSchema = z.enum(MEMBERSHIP_ROLES)
export const WorkPermissionSchema = z.enum(WORK_PERMISSIONS)

export type IdentityWorkspaceId = z.infer<typeof IdentityWorkspaceIdSchema>
export type PrincipalId = z.infer<typeof PrincipalIdSchema>
export type CredentialId = z.infer<typeof CredentialIdSchema>
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>
export type MembershipRole = z.infer<typeof MembershipRoleSchema>
export type WorkPermission = z.infer<typeof WorkPermissionSchema>

export type AuthenticatedPrincipal = {
  readonly credentialId: CredentialId
  readonly principalId: PrincipalId
  readonly workspaceId: IdentityWorkspaceId
}
