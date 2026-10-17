import { isJson, jsonSchema, ok } from "@slop-lab/part/contracts/index.js"
import type { Tools } from "@slop-lab/part/reference/index.js"
import { functionTool, installTool } from "@slop-lab/part/tools.js"
import type { z } from "zod"
import type {
  WorkspaceToolBundle,
  WorkspaceToolBundleConfig,
  WorkspaceToolCatalogEntry,
} from "../agent-runtime/types.ts"
import type { CommandAction } from "../pm/commands/types.ts"
import { COMMAND_TOOL_SPECS, type CommandToolSpec } from "./command-specs.ts"
import { WorkspaceToolConfigurationError } from "./errors.ts"
import { READ_TOOL_SPECS, type ReadToolSpec } from "./read-specs.ts"
import {
  commandInputSchema,
  modelSchema,
  partObjectSchema,
  partSchema,
  type ToolObject,
} from "./schemas.ts"
import { SnapshotTracker } from "./snapshots.ts"
import { createWorkspaceTransport, type WorkspaceTransport } from "./transport.ts"

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const FORBIDDEN_ACTIONS: ReadonlySet<CommandAction> = new Set(["space.access", "entity.access"])

export function createBundle(config: WorkspaceToolBundleConfig): WorkspaceToolBundle {
  const allowedActions = validateActions(config.allowedActions ?? [])
  const transport = createWorkspaceTransport({
    origin: config.origin,
    workspaceId: config.workspaceId,
    token: config.token,
    timeoutMs: positiveInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"),
    maxResponseBytes: positiveInteger(
      config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    ),
  })
  const snapshots = new SnapshotTracker(
    transport,
    positiveInteger(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs"),
  )
  const readTools = READ_TOOL_SPECS.map((spec) => installRead(spec, transport, snapshots))
  const commandTools = COMMAND_TOOL_SPECS.filter((spec) => allowedActions.has(spec.action)).map(
    (spec) => installCommand(spec, transport, snapshots),
  )
  const catalog = describeTools([...allowedActions])
  return {
    tools: [...readTools, ...commandTools],
    toolSchemas: Object.fromEntries(catalog.map((entry) => [entry.id, entry.inputSchema])),
    catalog,
    close: () => snapshots.close(),
  }
}

export function describeTools(
  allowedActions: readonly CommandAction[] = [],
): readonly WorkspaceToolCatalogEntry[] {
  const selected = validateActions(allowedActions)
  return [
    ...READ_TOOL_SPECS.map((spec) => ({
      id: spec.id,
      description: spec.description,
      effects: "read" as const,
      inputSchema: modelSchema(spec.input),
    })),
    ...COMMAND_TOOL_SPECS.filter((spec) => selected.has(spec.action)).map((spec) => {
      const input = inputForCommand(spec)
      return {
        id: commandToolId(spec.action),
        description: spec.description,
        effects: "write" as const,
        inputSchema: modelSchema(input),
        action: spec.action,
      }
    }),
  ]
}

function installRead(
  spec: ReadToolSpec,
  transport: WorkspaceTransport,
  snapshots: SnapshotTracker,
): Tools.InstalledTool {
  return functionTool({
    id: spec.id,
    description: spec.description,
    effects: "read",
    input: partObjectSchema(`${spec.id}/input`, spec.input),
    output: partSchema(`${spec.id}/output`, spec.output),
    async execute(input, context) {
      ensureOpen(snapshots)
      if (spec.id === "snapshot_release") {
        const snapshotId = Reflect.get(input, "snapshotId")
        if (typeof snapshotId !== "string") throw new TypeError("Missing snapshotId")
        await snapshots.release(snapshotId, context.signal)
        return null
      }
      const request = spec.request(input)
      const response = await snapshots.run((shutdownSignal) =>
        transport.request({
          ...request,
          signal: AbortSignal.any([context.signal, shutdownSignal]),
        }),
      )
      if (spec.snapshot) snapshots.capture(response)
      const parsed = spec.output.parse(response)
      if (!isJson(parsed)) throw new TypeError("Workspace response is not JSON")
      return parsed
    },
  })
}

function installCommand(
  spec: CommandToolSpec,
  transport: WorkspaceTransport,
  snapshots: SnapshotTracker,
): Tools.InstalledTool {
  const input = inputForCommand(spec)
  return installTool({
    definition: {
      id: commandToolId(spec.action),
      version: "1",
      description: spec.description,
      input: partObjectSchema(`${commandToolId(spec.action)}/input`, input),
      output: jsonSchema,
      executor: "part/function",
      effects: "write",
      cancellation: "cooperative",
      retrySafety: "never",
      requiredCapabilities: [],
    },
    async execute(value, context) {
      ensureOpen(snapshots)
      const commandId = context.operationId
      const body = {
        commandId,
        idempotencyKey: context.idempotencyKey ?? `agent-${commandId}`,
        baseRevision: Reflect.get(value, "baseRevision") ?? null,
        payload: Reflect.get(value, "payload") ?? {},
      }
      const response = await snapshots.run((shutdownSignal) =>
        transport.request({
          method: spec.method,
          path: commandPath(spec, value),
          body,
          signal: AbortSignal.any([context.signal, shutdownSignal]),
        }),
      )
      return ok({ value: response, content: [], artifacts: [], diagnostics: [] })
    },
  })
}

function inputForCommand(spec: CommandToolSpec): z.ZodType {
  return commandInputSchema({
    payload: spec.payload,
    parent: spec.path.includes(":parentId"),
    resource: spec.path.includes(":resourceId"),
  })
}

function commandPath(spec: CommandToolSpec, input: ToolObject): string {
  return `commands/v1/workspaces/:workspaceId${spec.path
    .replace(":parentId", segment(input, "parentId"))
    .replace(":resourceId", segment(input, "resourceId"))}`
}

function segment(input: ToolObject, name: string): string {
  const value = input[name]
  return typeof value === "string" ? encodeURIComponent(value) : `missing-${name}`
}

function commandToolId(action: CommandAction): string {
  return `command_${action.replaceAll(".", "_")}`
}

function validateActions(actions: readonly CommandAction[]): ReadonlySet<CommandAction> {
  const known = new Set(COMMAND_TOOL_SPECS.map((spec) => spec.action))
  for (const action of actions) {
    if (FORBIDDEN_ACTIONS.has(action))
      throw new WorkspaceToolConfigurationError(`Authority-changing action is forbidden: ${action}`)
    if (!known.has(action))
      throw new WorkspaceToolConfigurationError(`Unknown command action: ${action}`)
  }
  return new Set(actions)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new WorkspaceToolConfigurationError(`${name} must be a positive integer`)
  return value
}

function ensureOpen(snapshots: SnapshotTracker): void {
  if (snapshots.closed) throw new WorkspaceToolConfigurationError("Workspace tool bundle is closed")
}
