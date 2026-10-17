import type { Contracts, Convenience, Model, Runtime } from "@slop-lab/part/reference/index.js"
import { createPartAgent } from "./agent.ts"
import { AgentCleanupError, AgentObservationGapError, AgentRunAdmissionError } from "./errors.ts"
import type { WorkspaceToolBundle } from "./types.ts"

export type RunOutput = (record: Contracts.Json) => void

function responseText(response: Model.Response): string {
  return response.content
    .filter(
      (part): part is Extract<Model.ContentPart, { readonly kind: "text" }> => part.kind === "text",
    )
    .map((part) => part.text)
    .join("")
}

function doneRecord(outcome: Runtime.ManagedOutcome<Model.Response>): Contracts.Json {
  switch (outcome.phase) {
    case "completed":
      return {
        type: "done",
        phase: outcome.phase,
        effect: outcome.effect,
        text: responseText(outcome.result),
      }
    case "failed":
    case "abandoned":
      return {
        type: "done",
        phase: outcome.phase,
        effect: outcome.effect,
        error: { code: outcome.error.code, category: outcome.error.category },
      }
    case "cancelled":
      return { type: "done", phase: outcome.phase, effect: outcome.effect }
  }
}

function cleanupFailure(): Contracts.Failure {
  return {
    code: "agent.cleanup.exception",
    category: "internal",
    message: "Agent resource cleanup failed",
    retry: "never",
  }
}

async function cleanupResources(
  agent: ReturnType<typeof createPartAgent> | undefined,
  bundle: WorkspaceToolBundle | undefined,
): Promise<Contracts.CleanupReport> {
  const operations: Promise<Contracts.CleanupReport>[] = []
  if (agent !== undefined) operations.push(Promise.resolve().then(() => agent.dispose()))
  if (bundle !== undefined) operations.push(Promise.resolve().then(() => bundle.close()))
  const settled = await Promise.allSettled(operations)
  return {
    released: settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value.released : [],
    ),
    unresolved: settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value.unresolved : [],
    ),
    errors: settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value.errors : [cleanupFailure()],
    ),
  }
}

function requireCompleteCleanup(
  report: Contracts.CleanupReport,
  effect: Contracts.EffectState,
  output: RunOutput,
): void {
  if (report.unresolved.length === 0 && report.errors.length === 0) return
  output({
    type: "done",
    phase: "failed",
    effect,
    error: { code: "agent.cleanup", category: "internal" },
    cleanup: { unresolved: report.unresolved.length, errors: report.errors.length },
  })
  throw new AgentCleanupError(report.unresolved.length, report.errors.length)
}

export async function runPartPrompt(options: {
  readonly model: Convenience.ConfiguredModel
  readonly prompt: string
  readonly output: RunOutput
  readonly signal?: AbortSignal
  readonly bundle?: WorkspaceToolBundle
}): Promise<Runtime.ManagedOutcome<Model.Response>> {
  let agent: ReturnType<typeof createPartAgent> | undefined
  let handle: Runtime.ExecutionHandle<Model.Response> | undefined
  let cleaned = false
  const cancel = () => {
    if (handle !== undefined) void handle.requestCancel("process signal")
  }
  options.signal?.addEventListener("abort", cancel, { once: true })
  try {
    agent = createPartAgent({
      model: options.model,
      ...(options.bundle === undefined
        ? {}
        : { tools: options.bundle.tools, toolSchemas: options.bundle.toolSchemas }),
    })
    const started = await agent.start(options.prompt)
    if (!started.ok) throw new AgentRunAdmissionError(started.error)
    handle = started.value
    options.output({
      type: "start",
      run: { owner: handle.ref.owner, kind: handle.ref.kind, id: handle.ref.id },
    })
    if (options.signal?.aborted) await handle.requestCancel("process signal")
    const observation = (async () => {
      for await (const update of handle.observe({ bufferSize: 4096 })) {
        if (update.kind === "gap") {
          await handle?.requestCancel("event observation gap")
          throw new AgentObservationGapError(update.from, update.to, update.recovery)
        }
        options.output({
          type: "event",
          index: update.index,
          event: update.type,
          payload: update.payload,
        })
      }
    })()
    const [outcome] = await Promise.all([handle.done, observation])
    const cleanup = await cleanupResources(agent, options.bundle)
    cleaned = true
    requireCompleteCleanup(cleanup, outcome.effect, options.output)
    options.output(doneRecord(outcome))
    return outcome
  } finally {
    options.signal?.removeEventListener("abort", cancel)
    if (!cleaned) {
      const cleanup = await cleanupResources(agent, options.bundle)
      requireCompleteCleanup(cleanup, handle?.snapshot().effect ?? "unknown", options.output)
    }
  }
}
