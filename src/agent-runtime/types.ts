import type { Contracts, Convenience, Tools } from "@slop-lab/part/reference/index.js"
import type { CommandAction } from "../pm/commands/types.ts"

export type AgentEnvironment = Readonly<{
  AFW_AGENT_TOKEN?: string
  AFW_API_URL?: string
  AFW_WORKSPACE_ID?: string
  PART_PROVIDER?: string
  PART_MODEL?: string
  PART_MODEL_URL?: string
  PART_API_KEY?: string
  readonly [name: string]: string | undefined
}>

export type WorkspaceToolCatalogEntry = {
  readonly id: string
  readonly description: string
  readonly effects: "read" | "write"
  readonly inputSchema: Contracts.Json
  readonly action?: CommandAction
}

export type WorkspaceToolBundle = {
  readonly tools: readonly Tools.InstalledTool[]
  readonly toolSchemas: Readonly<Record<string, Contracts.Json>>
  readonly catalog: readonly WorkspaceToolCatalogEntry[]
  close(): Promise<Contracts.CleanupReport>
}

export type WorkspaceToolBundleConfig = {
  readonly origin: string
  readonly workspaceId: string
  readonly token: () => string | Promise<string>
  readonly allowedActions?: readonly CommandAction[]
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

export type RuntimeDependencies = {
  readonly createWorkspaceToolBundle: (config: WorkspaceToolBundleConfig) => WorkspaceToolBundle
  readonly describeWorkspaceTools: (
    allowedActions?: readonly CommandAction[],
  ) => readonly WorkspaceToolCatalogEntry[]
  readonly demoModel?: () => Convenience.ConfiguredModel
}
