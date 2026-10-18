import type { Sql, TransactionSql } from "postgres"
import {
  AutomationCreateSchema,
  ExtensionApprovalSchema,
  ExtensionManifestSchema,
  GitHubInstallationSchema,
  RecurrenceCreateSchema,
} from "../contracts/automation/index.ts"
import { type BatchMutationResult, CommandUnitOfWork } from "../entities/command-unit-of-work.ts"
import { CommandInvariantError, EntityNotFoundError } from "../entities/errors.ts"
import type { FeatureCommandCall } from "../http/feature-command-router.ts"
import { requireSpaceAccess } from "../pm/commands/helpers.ts"
import {
  requireAssignmentAccess,
  validateAssignment,
} from "../pm/commands/work-item-command-persistence.ts"
import {
  addAutomationDependency,
  automationEntityId,
  automationRecord,
  insertAutomationEntity,
  jsonRow,
} from "./persistence.ts"
import { mapGitHubEntity, submitExtensionManifest } from "./registry-direct-actions.ts"

export type RegistryAction =
  | "recurrence.create"
  | "automation.create"
  | "github.install"
  | "github.map"
  | "extension.submit"
  | "extension.approve"

export class AutomationRegistryService {
  readonly #sql: Sql
  readonly #unit: CommandUnitOfWork
  constructor(sql: Sql) {
    this.#sql = sql
    this.#unit = new CommandUnitOfWork(sql)
  }

  execute(call: FeatureCommandCall<RegistryAction>): Promise<BatchMutationResult> {
    switch (call.action) {
      case "recurrence.create":
        return this.#recurrence(call)
      case "automation.create":
        return this.#automation(call)
      case "github.install":
        return this.#github(call)
      case "extension.approve":
        return this.#approve(call)
      case "github.map":
      case "extension.submit":
        throw new CommandInvariantError("non_entity_registry_action")
      default:
        return assertNever(call.action)
    }
  }

  async submitManifest(
    call: FeatureCommandCall<RegistryAction>,
  ): Promise<{ readonly id: string; readonly version: string }> {
    return submitExtensionManifest(this.#sql, call)
  }

  async mapGitHub(call: FeatureCommandCall<RegistryAction>): Promise<{ readonly mapped: true }> {
    return mapGitHubEntity(this.#sql, call)
  }

  #recurrence(call: FeatureCommandCall<RegistryAction>): Promise<BatchMutationResult> {
    const value = RecurrenceCreateSchema.parse(call.payload)
    const id = automationEntityId("recurrence", call.workspaceId, call.idempotencyKey)
    return this.#unit.execute(command(call, id), [target(id, "automation.manage")], async (tx) => {
      await requireTemplate(tx, call, value.templateId, value.templateRevision, value.targetSpaceId)
      await insertAutomationEntity(tx, {
        id,
        workspaceId: call.workspaceId,
        kind: "recurrence",
        spaceId: value.targetSpaceId,
        actorId: call.principal.principalId,
      })
      await tx`insert into recurrence_rules
        (id,workspace_id,template_id,template_revision,target_space_id,schedule,timezone,incomplete_policy,
         title,next_run_at,revision,created_by,created_at)
        values (${id},${call.workspaceId},${value.templateId},${value.templateRevision},${value.targetSpaceId},
          ${JSON.stringify(value.schedule)}::text::jsonb,${value.timezone},${value.incompletePolicy},${value.title},${value.nextRunAt},
          1,${call.principal.principalId},clock_timestamp())`
      await addAutomationDependency(tx, id, value.templateId)
      const record = automationRecord({
        id,
        kind: "recurrence",
        revision: 1,
        snapshot: await tableSnapshot(tx, "recurrence_rules", id),
      })
      return { primaryEntityId: id, records: [record] }
    })
  }

  #automation(call: FeatureCommandCall<RegistryAction>): Promise<BatchMutationResult> {
    const value = AutomationCreateSchema.parse(call.payload)
    const id = automationEntityId("automation", call.workspaceId, call.idempotencyKey)
    return this.#unit.execute(command(call, id), [target(id, "automation.manage")], async (tx) => {
      await insertAutomationEntity(tx, {
        id,
        workspaceId: call.workspaceId,
        kind: "automation_rule",
        spaceId: null,
        actorId: call.principal.principalId,
      })
      await tx`insert into automation_rules
        (id,workspace_id,name,enabled,trigger_spec,conditions,actions,max_runs_per_minute,version,revision,
         owner_id,created_at) values (${id},${call.workspaceId},${value.name},${value.enabled},
          jsonb_build_object('eventType',${value.trigger.eventType}::text),
          ${JSON.stringify(value.conditions)}::text::jsonb,
          ${JSON.stringify(value.actions)}::text::jsonb,
          ${value.maxRunsPerMinute},1,1,${call.principal.principalId},clock_timestamp())`
      const record = automationRecord({
        id,
        kind: "automation_rule",
        revision: 1,
        snapshot: await tableSnapshot(tx, "automation_rules", id),
      })
      return { primaryEntityId: id, records: [record] }
    })
  }

  #github(call: FeatureCommandCall<RegistryAction>): Promise<BatchMutationResult> {
    const value = GitHubInstallationSchema.parse(call.payload)
    if (!value.allowedHosts.includes(new URL(value.apiBaseUrl).hostname))
      throw new CommandInvariantError("github_api_host_not_allowed")
    const id = automationEntityId("github", call.workspaceId, value.externalInstallationId)
    return this.#unit.execute(command(call, id), [target(id, "admin.integrations")], async (tx) => {
      await insertAutomationEntity(tx, {
        id,
        workspaceId: call.workspaceId,
        kind: "github_installation",
        spaceId: null,
        actorId: call.principal.principalId,
      })
      await tx`insert into github_installations
        (id,workspace_id,external_installation_id,repository,webhook_secret,api_base_url,allowed_hosts,
         revision,created_by,created_at) values (${id},${call.workspaceId},${value.externalInstallationId},
          ${value.repository},${Buffer.from(value.webhookSecret)},${value.apiBaseUrl},${tx.array(value.allowedHosts)},
          1,${call.principal.principalId},clock_timestamp())`
      const record = automationRecord({
        id,
        kind: "github_installation",
        revision: 1,
        snapshot: {
          id,
          repository: value.repository,
          apiBaseUrl: value.apiBaseUrl,
          allowedHosts: value.allowedHosts,
        },
      })
      return { primaryEntityId: id, records: [record] }
    })
  }

  #approve(call: FeatureCommandCall<RegistryAction>): Promise<BatchMutationResult> {
    const value = ExtensionApprovalSchema.parse(call.payload)
    const id = automationEntityId("extension", call.workspaceId, value.manifestId)
    return this.#unit.execute(command(call, id), [target(id, "admin.integrations")], async (tx) => {
      const rows = await tx<
        { readonly manifest: unknown }[]
      >`select manifest from extension_manifests where manifest_id=${value.manifestId} and version=${value.manifestVersion}`
      const manifest = ExtensionManifestSchema.parse(rows[0]?.manifest)
      const requested: ReadonlySet<string> = new Set(manifest.permissions)
      if (value.approvedPermissions.some((permission) => !requested.has(permission)))
        throw new CommandInvariantError("extension_permission_not_requested")
      await insertAutomationEntity(tx, {
        id,
        workspaceId: call.workspaceId,
        kind: "extension_installation",
        spaceId: null,
        actorId: call.principal.principalId,
      })
      await tx`insert into extension_installations
        (id,workspace_id,manifest_id,manifest_version,approved_permissions,endpoint_url,revision,approved_by,approved_at)
        values (${id},${call.workspaceId},${value.manifestId},${value.manifestVersion},
          ${tx.array(value.approvedPermissions)},${manifest.endpointUrl},1,${call.principal.principalId},clock_timestamp())`
      const record = automationRecord({
        id,
        kind: "extension_installation",
        revision: 1,
        snapshot: {
          id,
          manifestId: value.manifestId,
          manifestVersion: value.manifestVersion,
          permissions: value.approvedPermissions,
          endpointUrl: manifest.endpointUrl,
        },
      })
      return { primaryEntityId: id, records: [record] }
    })
  }
}

async function requireTemplate(
  tx: TransactionSql,
  call: FeatureCommandCall<RegistryAction>,
  templateId: string,
  revision: number,
  spaceId: string,
): Promise<void> {
  await requireSpaceAccess(tx, {
    principal: call.principal,
    spaceId,
    permission: "work.create",
  })
  const canonicalCall = { ...call, action: "work-item.create" as const }
  await requireAssignmentAccess(tx, canonicalCall, { spaceId })
  await validateAssignment(tx, canonicalCall, call.principal.principalId, spaceId)
  const rows = await tx`select 1 from planning_template_revisions r join planning_templates t
    on t.id=r.template_id where t.workspace_id=${call.workspaceId}
      and r.template_id=${templateId} and r.revision=${revision}`
  if (rows.length !== 1) throw new EntityNotFoundError(templateId)
  const access = await tx`select 1 from entities e join entity_kind_registry registry
    on registry.kind=e.kind where e.workspace_id=${call.workspaceId} and e.id=${templateId}
      and e.kind='planning_template' and entity_access_allowed(e.workspace_id,e.id,
      ${call.principal.principalId},registry.read_permission)`
  if (access.length !== 1) throw new EntityNotFoundError(templateId)
}
async function tableSnapshot(
  tx: TransactionSql,
  table: "recurrence_rules" | "automation_rules",
  id: string,
) {
  const rows = await tx.unsafe<{ readonly snapshot: unknown }[]>(
    `select to_jsonb(t) snapshot from ${table} t where id=$1`,
    [id],
  )
  return jsonRow(rows[0]?.snapshot)
}
function command(call: FeatureCommandCall<RegistryAction>, primaryEntityId: string) {
  return { ...call, primaryEntityId }
}
function target(entityId: string, permission: "automation.manage" | "admin.integrations") {
  return { entityId, expectedRevision: null, permission }
}
function assertNever(value: never): never {
  throw new CommandInvariantError(`unsupported_registry_action:${value}`)
}
