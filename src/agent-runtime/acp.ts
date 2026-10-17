import type { Readable, Writable } from "node:stream"
import { emptyCleanup } from "@slop-lab/part/contracts/index.js"
import type { Contracts, Convenience } from "@slop-lab/part/reference/index.js"
import { AcpRpcError, startAcpStdio } from "@slop-lab/part-node/acp/index.js"
import type { AcpHandler, AcpPeer } from "@slop-lab/part-node/acp/types.js"
import { createAcpAgent } from "@slop-lab/part-plugins/acp/index.js"
import { MAX_MODEL_INVOCATIONS, MAX_TOOL_DISPATCHES } from "./agent.ts"
import type { RuntimeDependencies, WorkspaceToolBundleConfig } from "./types.ts"

export type WorkspaceAcpOptions = {
  readonly dependencies: RuntimeDependencies
  readonly bundle: WorkspaceToolBundleConfig
  readonly model: () => Convenience.ConfiguredModel
  readonly input?: Readable
  readonly output?: Writable
}

type BundleRegistration = {
  readonly bundle: ReturnType<RuntimeDependencies["createWorkspaceToolBundle"]>
  closing?: Promise<Contracts.CleanupReport>
}

function mergeCleanup(reports: readonly Contracts.CleanupReport[]): Contracts.CleanupReport {
  return reports.reduce(
    (all, report) => ({
      released: [...all.released, ...report.released],
      unresolved: [...all.unresolved, ...report.unresolved],
      errors: [...all.errors, ...report.errors],
    }),
    emptyCleanup(),
  )
}

function failedCleanup(): Contracts.CleanupReport {
  return {
    released: [],
    unresolved: [],
    errors: [
      {
        code: "agent.cleanup.exception",
        category: "internal",
        message: "Agent resource cleanup failed",
        retry: "never",
      },
    ],
  }
}

function settleCleanup(
  operation: Promise<Contracts.CleanupReport>,
): Promise<Contracts.CleanupReport> {
  return operation.catch(() => failedCleanup())
}

function createWorkspaceAcpHandler(connection: AcpPeer, options: WorkspaceAcpOptions): AcpHandler {
  const bundles = new Map<string, BundleRegistration>()
  const bundleReports: Contracts.CleanupReport[] = []
  const closeBundle = (sessionId: string): Promise<Contracts.CleanupReport> => {
    const registered = bundles.get(sessionId)
    if (registered === undefined) return Promise.resolve(emptyCleanup())
    registered.closing ??= settleCleanup(
      Promise.resolve().then(() => registered.bundle.close()),
    ).then((report) => {
      bundleReports.push(report)
      if (bundles.get(sessionId) === registered) bundles.delete(sessionId)
      return report
    })
    return registered.closing
  }
  const agent = createAcpAgent({
    connection,
    permissions: "writes",
    maxSessions: 16,
    maxHistoryTurns: 32,
    turnTimeoutMs: 180_000,
    configureSession: (setup) => {
      const bundle = options.dependencies.createWorkspaceToolBundle(options.bundle)
      bundles.set(setup.sessionId, { bundle })
      return {
        model: options.model(),
        tools: bundle.tools,
        toolSchemas: bundle.toolSchemas,
        limits: {
          maxModelInvocations: MAX_MODEL_INVOCATIONS,
          maxToolDispatches: MAX_TOOL_DISPATCHES,
        },
      }
    },
  })
  return {
    async handle(method, params, kind, signal) {
      const result = await agent.handle(method, params, kind, signal)
      if (method === "session/close" && typeof params === "object" && params !== null) {
        const sessionId = Reflect.get(params, "sessionId")
        if (typeof sessionId === "string") {
          const cleanup = await closeBundle(sessionId)
          if (cleanup.unresolved.length > 0 || cleanup.errors.length > 0) {
            throw new AcpRpcError(-32603, "Workspace tool cleanup incomplete")
          }
        }
      }
      return result
    },
    async close() {
      const agentClosing = settleCleanup(Promise.resolve().then(() => agent.close()))
      const bundleClosing = [...bundles.keys()].map(closeBundle)
      const [agentReport] = await Promise.all([agentClosing, ...bundleClosing])
      return mergeCleanup([agentReport, ...bundleReports])
    },
  }
}

export function startWorkspaceAcp(options: WorkspaceAcpOptions) {
  return startAcpStdio({
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.output === undefined ? {} : { output: options.output }),
    maxFrameBytes: 1024 * 1024,
    maxPendingRequests: 32,
    maxConcurrentRequests: 16,
    maxQueuedBytes: 4 * 1024 * 1024,
    requestTimeoutMs: 180_000,
    writeTimeoutMs: 30_000,
    createHandler: (connection) => createWorkspaceAcpHandler(connection, options),
  })
}
