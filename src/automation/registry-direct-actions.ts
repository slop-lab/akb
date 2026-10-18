import { createHash } from "node:crypto"
import type { Sql } from "postgres"
import { ExtensionManifestSchema, GitHubMappingSchema } from "../contracts/automation/index.ts"
import { EntityNotFoundError } from "../entities/errors.ts"
import type { FeatureCommandCall } from "../http/feature-command-router.ts"
import type { RegistryAction } from "./registry-service.ts"

export async function submitExtensionManifest(
  sql: Sql,
  call: FeatureCommandCall<RegistryAction>,
): Promise<{ readonly id: string; readonly version: string }> {
  const value = ExtensionManifestSchema.parse(call.payload)
  await requireIntegrationPermission(sql, call.workspaceId, call.principal.principalId)
  const manifest = JSON.stringify(value)
  const digest = createHash("sha256").update(manifest).digest("hex")
  await sql`insert into extension_manifests
    (manifest_id,version,protocol_version,manifest,digest,submitted_by,submitted_at)
    values (${value.id},${value.version},${value.protocolVersion},${manifest}::text::jsonb,
      ${digest},${call.principal.principalId},clock_timestamp())`
  return { id: value.id, version: value.version }
}

export async function mapGitHubEntity(
  sql: Sql,
  call: FeatureCommandCall<RegistryAction>,
): Promise<{ readonly mapped: true }> {
  const value = GitHubMappingSchema.parse(call.payload)
  await requireIntegrationPermission(sql, call.workspaceId, call.principal.principalId)
  const rows = await sql`insert into github_mappings(installation_id,github_number,entity_id)
    select ${value.installationId},${value.githubNumber},${value.entityId}
    from github_installations installation join entities entity on entity.id=${value.entityId}
    where installation.id=${value.installationId} and installation.workspace_id=${call.workspaceId}
      and entity.workspace_id=${call.workspaceId} returning installation_id`
  if (rows.length !== 1) throw new EntityNotFoundError(value.entityId)
  return { mapped: true }
}

async function requireIntegrationPermission(
  sql: Sql,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  const rows =
    await sql`select 1 from membership_permissions where workspace_id=${workspaceId} and principal_id=${principalId} and permission='admin.integrations'`
  if (rows.length !== 1) throw new EntityNotFoundError(workspaceId)
}
