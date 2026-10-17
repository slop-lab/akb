import type {
  Contracts,
  Convenience,
  Model,
  Runtime,
  Tools,
} from "@slop-lab/part/reference/index.js"
import type { BasicInput } from "@slop-lab/part-plugins/agent/drivers/basic.js"
import { createAgent } from "@slop-lab/part-plugins/agent/index.js"
import { AgentConfigurationError, AgentObservationGapError } from "./errors.ts"

export const MAX_MODEL_INVOCATIONS = 8
export const MAX_TOOL_DISPATCHES = 16
const RUN_DEADLINE_MS = 180_000

export type PartAgentOptions = {
  readonly model: Convenience.ConfiguredModel
  readonly tools?: readonly Tools.InstalledTool[]
  readonly toolSchemas?: Readonly<Record<string, Contracts.Json>>
  readonly components?: readonly import("@slop-lab/part/reference/index.js").Composition.ComponentFactory[]
  readonly principal?: Contracts.InvocationContext["principal"]
  readonly deadlineMs?: number
}

export type ObservedRun = {
  readonly outcome: Runtime.ManagedOutcome<Model.Response>
  readonly events: readonly Extract<Runtime.Update, { readonly kind: "data" }>[]
}

export function createPartAgent(
  options: PartAgentOptions,
): Convenience.Agent<BasicInput, Model.Response> {
  const deadlineMs = options.deadlineMs ?? RUN_DEADLINE_MS
  const configured = createAgent({
    model: options.model,
    limits: {
      maxModelInvocations: MAX_MODEL_INVOCATIONS,
      maxToolDispatches: MAX_TOOL_DISPATCHES,
      deadline: new Date(Date.now() + deadlineMs).toISOString(),
    },
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.toolSchemas === undefined ? {} : { toolSchemas: options.toolSchemas }),
    ...(options.components === undefined ? {} : { components: options.components }),
    ...(options.principal === undefined ? {} : { principal: options.principal }),
  })
  if (!configured.ok) throw new AgentConfigurationError(configured.error)
  return configured.value
}

export async function observeRun(
  handle: Runtime.ExecutionHandle<Model.Response>,
): Promise<ObservedRun> {
  const events: Extract<Runtime.Update, { readonly kind: "data" }>[] = []
  const observation = (async () => {
    for await (const update of handle.observe({ bufferSize: 4096 })) {
      if (update.kind === "gap") {
        throw new AgentObservationGapError(update.from, update.to, update.recovery)
      }
      events.push(update)
    }
  })()
  const [outcome] = await Promise.all([handle.done, observation])
  return { outcome, events }
}
