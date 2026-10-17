import { z } from "zod"
import { COMMAND_ACTIONS, type CommandAction } from "../pm/commands/types.ts"
import { AgentInputError } from "./errors.ts"
import type { AgentEnvironment, WorkspaceToolBundleConfig } from "./types.ts"

const CommandActionSchema = z.enum(COMMAND_ACTIONS)
const WorkspaceEnvironmentSchema = z.object({
  AFW_AGENT_TOKEN: z.string().min(1),
  AFW_API_URL: z.url(),
  AFW_WORKSPACE_ID: z.string().min(1),
})

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "tools"; readonly allowedActions: readonly CommandAction[] }
  | { readonly kind: "demo"; readonly prompt: string }
  | {
      readonly kind: "run"
      readonly prompt: string
      readonly allowedActions: readonly CommandAction[]
    }
  | { readonly kind: "acp"; readonly allowedActions: readonly CommandAction[] }

function options(values: readonly string[]): readonly CommandAction[] {
  const actions: CommandAction[] = []
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index]
    if (option !== "--allow-action") throw new AgentInputError(`unknown option: ${option ?? ""}`)
    const action = values[index + 1]
    if (action === undefined) throw new AgentInputError("--allow-action requires a value")
    actions.push(CommandActionSchema.parse(action))
    index += 1
  }
  return actions
}

export function parseCliCommand(arguments_: readonly string[]): CliCommand {
  const [command, ...rest] = arguments_
  if (command === undefined || command === "--help" || command === "help") return { kind: "help" }
  if (command === "tools") return { kind: "tools", allowedActions: options(rest) }
  if (command === "acp") return { kind: "acp", allowedActions: options(rest) }
  if (command === "demo") {
    if (rest.length > 1) throw new AgentInputError("demo accepts at most one prompt")
    return { kind: "demo", prompt: rest[0] ?? "Say hello in one sentence." }
  }
  if (command === "run") {
    const prompt = rest[0]
    if (prompt === undefined || prompt.startsWith("--")) {
      throw new AgentInputError("run requires a prompt")
    }
    return { kind: "run", prompt, allowedActions: options(rest.slice(1)) }
  }
  throw new AgentInputError(`unknown command: ${command}`)
}

export function parseWorkspaceEnvironment(
  environment: AgentEnvironment,
  allowedActions: readonly CommandAction[],
): WorkspaceToolBundleConfig {
  const parsed = WorkspaceEnvironmentSchema.parse({
    AFW_AGENT_TOKEN: environment.AFW_AGENT_TOKEN,
    AFW_API_URL: environment.AFW_API_URL,
    AFW_WORKSPACE_ID: environment.AFW_WORKSPACE_ID,
  })
  return {
    origin: parsed.AFW_API_URL,
    workspaceId: parsed.AFW_WORKSPACE_ID,
    token: () => environment.AFW_AGENT_TOKEN ?? "",
    allowedActions,
  }
}

export function supportsAgentRuntime(version: string): boolean {
  const parsed = z
    .string()
    .regex(/^\d+\.\d+\.\d+/)
    .safeParse(version)
  if (!parsed.success) return false
  const [major = 0, minor = 0, patch = 0] = parsed.data.split(".").map(Number)
  return major > 24 || (major === 24 && (minor > 22 || (minor === 22 && patch >= 0)))
}
