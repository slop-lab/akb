import type {
  WorkspaceToolBundle,
  WorkspaceToolBundleConfig,
  WorkspaceToolCatalogEntry,
} from "../agent-runtime/types.ts"
import type { CommandAction } from "../pm/commands/types.ts"
import { createBundle, describeTools } from "./bundle.ts"

export function createWorkspaceToolBundle(config: WorkspaceToolBundleConfig): WorkspaceToolBundle {
  return createBundle(config)
}

export function describeWorkspaceTools(
  allowedActions: readonly CommandAction[] = [],
): readonly WorkspaceToolCatalogEntry[] {
  return describeTools(allowedActions)
}

export { COMMAND_TOOL_SPECS } from "./command-specs.ts"
