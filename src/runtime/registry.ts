import { createHash } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import type {
  CreateDefinitionInput,
  CreateInstallationInput,
  CreateRuntimeEndpointInput,
} from "../contracts/runtime/index.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { RuntimeConflictError, RuntimeNotFoundError } from "./errors.ts"
import { toJsonValue } from "./json.ts"

const DefinitionRowSchema = z.strictObject({
  roles: z.array(z.string()),
  required_capabilities: z.array(z.string()),
})
const EndpointRowSchema = z.strictObject({
  supported_roles: z.array(z.string()),
  supported_capabilities: z.array(z.string()),
})

export class RuntimeRegistry {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  async createDefinition(
    principal: AuthenticatedPrincipal,
    input: CreateDefinitionInput,
  ): Promise<{ readonly definitionId: string; readonly revisionId: string }> {
    return this.#sql.begin(async (transaction) => {
      await requireRegistryAuthority(transaction, principal)
      const digest = createHash("sha256").update(JSON.stringify(input.manifest)).digest("hex")
      await transaction`insert into agent_definitions
        (workspace_id,id,display_name,created_by) values
        (${principal.workspaceId},${input.definitionId},${input.displayName},${principal.principalId})
        on conflict (workspace_id,id) do nothing`
      const inserted = await transaction`insert into agent_definition_revisions
        (id,workspace_id,definition_id,roles,required_capabilities,manifest,digest,created_by)
        values (${input.revisionId},${principal.workspaceId},${input.definitionId},
          ${transaction.json(input.roles)},${transaction.json(input.requiredCapabilities)},
          ${transaction.json(toJsonValue(input.manifest))},${digest},${principal.principalId})
        on conflict (id) do nothing returning id`
      if (inserted.length !== 1) throw new RuntimeConflictError("immutable_revision_conflict")
      return { definitionId: input.definitionId, revisionId: input.revisionId }
    })
  }

  async createEndpoint(
    principal: AuthenticatedPrincipal,
    input: CreateRuntimeEndpointInput,
  ): Promise<{ readonly endpointId: string }> {
    return this.#sql.begin(async (transaction) => {
      await requireRegistryAuthority(transaction, principal)
      await transaction`insert into runtime_endpoints
        (workspace_id,id,protocol_version,mode,supported_roles,supported_capabilities,
         max_concurrency,heartbeat_seconds) values
        (${principal.workspaceId},${input.endpointId},${input.protocolVersion},${input.mode},
         ${transaction.json(input.supportedRoles)},${transaction.json(input.supportedCapabilities)},
         ${input.maxConcurrency},${input.heartbeatSeconds})`
      return { endpointId: input.endpointId }
    })
  }

  async createInstallation(
    principal: AuthenticatedPrincipal,
    input: CreateInstallationInput,
  ): Promise<{ readonly installationId: string; readonly principalId: string }> {
    return this.#sql.begin(async (transaction) => {
      await requireRegistryAuthority(transaction, principal)
      const definitions = await transaction`select roles,required_capabilities
        from agent_definition_revisions where workspace_id=${principal.workspaceId}
          and id=${input.definitionRevisionId}`
      const endpoints = await transaction`select supported_roles,supported_capabilities
        from runtime_endpoints where workspace_id=${principal.workspaceId}
          and id=${input.runtimeEndpointId} and enabled for update`
      if (definitions[0] === undefined || endpoints[0] === undefined)
        throw new RuntimeNotFoundError()
      const definition = DefinitionRowSchema.parse(definitions[0])
      const endpoint = EndpointRowSchema.parse(endpoints[0])
      const capabilities = new Set<string>(input.capabilities)
      const supported = new Set(endpoint.supported_capabilities)
      if (
        definition.required_capabilities.some((value) => !capabilities.has(value)) ||
        input.capabilities.some((value) => !supported.has(value)) ||
        !definition.roles.some((role) => endpoint.supported_roles.includes(role))
      ) {
        throw new RuntimeConflictError("capability_unavailable")
      }
      await transaction`insert into principals (id,workspace_id,display_name,kind)
        values (${input.principalId},${principal.workspaceId},${input.displayName},'runtime')`
      await transaction`insert into workspace_memberships (workspace_id,principal_id,role)
        values (${principal.workspaceId},${input.principalId},'guest')`
      for (const permission of new Set(input.permissions)) {
        await transaction`insert into membership_permissions
          (workspace_id,principal_id,permission) values
          (${principal.workspaceId},${input.principalId},${permission})`
      }
      await transaction`insert into agent_installations
        (workspace_id,id,definition_revision_id,runtime_endpoint_id,principal_id,scopes,
         permissions,capabilities,mentionable,delegatable,created_by) values
        (${principal.workspaceId},${input.installationId},${input.definitionRevisionId},
         ${input.runtimeEndpointId},${input.principalId},${transaction.json(input.scopes)},
         ${transaction.json(input.permissions)},${transaction.json(input.capabilities)},
         ${input.mentionable},${input.delegatable},${principal.principalId})`
      return { installationId: input.installationId, principalId: input.principalId }
    })
  }
}

async function requireRegistryAuthority(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
): Promise<void> {
  if (!(await lockAuthenticatedPrincipal(transaction, principal))) throw new RuntimeNotFoundError()
  const rows = await transaction`select 1 from membership_permissions where
    workspace_id=${principal.workspaceId} and principal_id=${principal.principalId}
    and permission='admin.integrations'`
  if (rows.length !== 1) throw new RuntimeNotFoundError()
}
