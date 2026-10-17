import type { Contracts } from "@slop-lab/part/reference/index.js"
import { z } from "zod"
import type { WorkspaceTransport } from "./transport.ts"

const SnapshotResponseSchema = z
  .object({ snapshot: z.object({ id: z.string().uuid() }) })
  .passthrough()
const CLEANUP_CONCURRENCY = 4

export class SnapshotTracker {
  readonly #transport: WorkspaceTransport
  readonly #cleanupTimeoutMs: number
  readonly #snapshots = new Set<string>()
  readonly #active = new Set<Promise<unknown>>()
  readonly #requests = new AbortController()
  #closed = false
  #closing: Promise<Contracts.CleanupReport> | undefined

  constructor(transport: WorkspaceTransport, cleanupTimeoutMs: number) {
    this.#transport = transport
    this.#cleanupTimeoutMs = cleanupTimeoutMs
  }

  get closed(): boolean {
    return this.#closed
  }

  capture(value: Contracts.Json): void {
    const parsed = SnapshotResponseSchema.safeParse(value)
    if (parsed.success) this.#snapshots.add(parsed.data.snapshot.id)
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const active = operation(this.#requests.signal)
    this.#active.add(active)
    try {
      return await active
    } finally {
      this.#active.delete(active)
    }
  }

  async release(snapshotId: string, signal?: AbortSignal): Promise<void> {
    await this.run((shutdownSignal) =>
      this.#transport.release(
        snapshotId,
        signal === undefined ? shutdownSignal : AbortSignal.any([signal, shutdownSignal]),
      ),
    )
    this.#snapshots.delete(snapshotId)
  }

  close(): Promise<Contracts.CleanupReport> {
    this.#closed = true
    this.#requests.abort()
    this.#closing ??= this.#finishClose([...this.#active])
    return this.#closing
  }

  async #finishClose(active: readonly Promise<unknown>[]): Promise<Contracts.CleanupReport> {
    await Promise.allSettled(active)
    return this.#releaseAll()
  }

  async #releaseAll(): Promise<Contracts.CleanupReport> {
    const released: Contracts.EntityRef[] = []
    const unresolved: Contracts.EntityRef[] = []
    const errors: Contracts.Failure[] = []
    const pending = [...this.#snapshots]
    const settled = new Set<string>()
    const queue = pending.values()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#cleanupTimeoutMs)
    const worker = async () => {
      while (!controller.signal.aborted) {
        const next = queue.next()
        if (next.done) return
        const snapshotId = next.value
        try {
          await this.#transport.release(snapshotId, controller.signal)
          released.push(snapshotRef(snapshotId))
        } catch {
          unresolved.push(snapshotRef(snapshotId))
          errors.push(cleanupFailure("release_failed"))
        } finally {
          settled.add(snapshotId)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CLEANUP_CONCURRENCY, pending.length) }, worker))
    clearTimeout(timer)
    for (const snapshotId of pending) {
      if (settled.has(snapshotId)) continue
      unresolved.push(snapshotRef(snapshotId))
      errors.push(cleanupFailure("timeout"))
    }
    this.#snapshots.clear()
    return { released, unresolved, errors }
  }
}

function snapshotRef(id: string): Contracts.EntityRef {
  return { owner: "agent-first-workspace", kind: "query-snapshot", id }
}

function cleanupFailure(reason: "release_failed" | "timeout"): Contracts.Failure {
  return {
    code: `workspace.snapshot.${reason}`,
    category: reason === "timeout" ? "timeout" : "unavailable",
    message: reason === "timeout" ? "Snapshot cleanup timed out" : "Snapshot release failed",
    retry: "safe-read",
  }
}
