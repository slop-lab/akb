import { z } from "zod"
import {
  AgentDefinitionIdSchema,
  AgentRevisionIdSchema,
  InstallationIdSchema,
  RuntimeEndpointIdSchema,
} from "./identifiers.ts"

export const RUNTIME_PROTOCOL_VERSION = "runtime.v1" as const
export const RuntimeCapabilitySchema = z.enum([
  "context.read",
  "activity.write",
  "plan.write",
  "artifact.write",
  "signal.write",
  "run.delegate",
])
export const EntityReadPermissionSchema = z.enum([
  "work.read",
  "space.read",
  "project.read",
  "comment.create",
  "history.read",
  "view.read",
])

export const CreateDefinitionInputSchema = z.strictObject({
  definitionId: AgentDefinitionIdSchema,
  revisionId: AgentRevisionIdSchema,
  displayName: z.string().trim().min(1).max(200),
  roles: z.array(z.string().trim().min(1).max(100)).min(1).max(32),
  requiredCapabilities: z.array(RuntimeCapabilitySchema).max(16),
  manifest: z.record(z.string(), z.unknown()),
})

export const CreateRuntimeEndpointInputSchema = z.strictObject({
  endpointId: RuntimeEndpointIdSchema,
  protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
  mode: z.enum(["push", "pull"]),
  supportedRoles: z.array(z.string().trim().min(1).max(100)).min(1).max(32),
  supportedCapabilities: z.array(RuntimeCapabilitySchema).max(16),
  maxConcurrency: z.number().int().min(1).max(100),
  heartbeatSeconds: z.number().int().min(5).max(300),
})

export const CreateInstallationInputSchema = z.strictObject({
  installationId: InstallationIdSchema,
  definitionRevisionId: AgentRevisionIdSchema,
  runtimeEndpointId: RuntimeEndpointIdSchema,
  principalId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  scopes: z.array(z.string().trim().min(1).max(200)).min(1).max(128),
  permissions: z.array(EntityReadPermissionSchema).max(16),
  capabilities: z.array(RuntimeCapabilitySchema).max(16),
  mentionable: z.boolean().default(false),
  delegatable: z.boolean().default(true),
})

export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>
export type CreateDefinitionInput = z.infer<typeof CreateDefinitionInputSchema>
export type CreateRuntimeEndpointInput = z.infer<typeof CreateRuntimeEndpointInputSchema>
export type CreateInstallationInput = z.infer<typeof CreateInstallationInputSchema>
