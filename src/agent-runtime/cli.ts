import { fakeModel } from "@slop-lab/part-plugins/testing/index.js"
import { z } from "zod"
import { startWorkspaceAcp } from "./acp.ts"
import { parseCliCommand, parseWorkspaceEnvironment, supportsAgentRuntime } from "./config.ts"
import { AgentCleanupError, AgentInputError } from "./errors.ts"
import { parseProviderEnvironment } from "./provider.ts"
import { runPartPrompt } from "./run.ts"
import type { AgentEnvironment, RuntimeDependencies } from "./types.ts"

const HELP = `Usage: agent-runtime <command>\n\nCommands:\n  tools [--allow-action ACTION]\n  demo [PROMPT]\n  run PROMPT [--allow-action ACTION]\n  acp [--allow-action ACTION]\n  help\n`

export type CliIo = {
  readonly stdout: (value: string) => void
  readonly stderr: (value: string) => void
}

export type CliRuntimeOptions = {
  readonly nodeVersion?: string
  readonly signal?: AbortSignal
}

export type AgentCliOptions = {
  readonly arguments: readonly string[]
  readonly environment: AgentEnvironment
  readonly io: CliIo
  readonly dependencies: RuntimeDependencies
  readonly runtime?: CliRuntimeOptions
}

export async function runAgentCli(options: AgentCliOptions): Promise<number> {
  const { arguments: arguments_, environment, io, dependencies } = options
  const runtime = options.runtime ?? {}
  if (!supportsAgentRuntime(runtime.nodeVersion ?? process.versions.node)) {
    io.stderr("Agent runtime requires Node.js 24.22.0 or newer.\n")
    return 1
  }
  try {
    const command = parseCliCommand(arguments_)
    switch (command.kind) {
      case "help":
        io.stdout(HELP)
        return 0
      case "tools":
        for (const tool of dependencies.describeWorkspaceTools(command.allowedActions)) {
          io.stdout(`${JSON.stringify(tool)}\n`)
        }
        return 0
      case "demo":
        return (
          await runPartPrompt({
            model: dependencies.demoModel?.() ?? fakeModel([{ text: "Local Part demo is ready." }]),
            prompt: command.prompt,
            output: (record) => io.stdout(`${JSON.stringify(record)}\n`),
            ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
          })
        ).phase === "completed"
          ? 0
          : 1
      case "run": {
        const bundleConfig = parseWorkspaceEnvironment(environment, command.allowedActions)
        const provider = parseProviderEnvironment(environment)
        const bundle = dependencies.createWorkspaceToolBundle(bundleConfig)
        const outcome = await runPartPrompt({
          model: provider.model,
          prompt: command.prompt,
          bundle,
          output: (record) => io.stdout(`${JSON.stringify(record)}\n`),
          ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
        })
        return outcome.phase === "completed" ? 0 : 1
      }
      case "acp": {
        const bundle = parseWorkspaceEnvironment(environment, command.allowedActions)
        const provider = parseProviderEnvironment(environment)
        const host = startWorkspaceAcp({ dependencies, bundle, model: () => provider.model })
        const close = () => void host.close()
        runtime.signal?.addEventListener("abort", close, { once: true })
        if (runtime.signal?.aborted) await host.close()
        const cleanup = await host.closed
        runtime.signal?.removeEventListener("abort", close)
        if (cleanup.unresolved.length > 0 || cleanup.errors.length > 0) {
          throw new AgentCleanupError(cleanup.unresolved.length, cleanup.errors.length)
        }
        return 0
      }
    }
  } catch (error) {
    if (error instanceof AgentCleanupError) io.stderr("agent cleanup incomplete\n")
    else if (error instanceof AgentInputError) io.stderr(`${error.message}\n`)
    else if (error instanceof z.ZodError)
      io.stderr("invalid environment or command configuration\n")
    else io.stderr("agent runtime failed\n")
    return 1
  }
}
