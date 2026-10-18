import type { Sql } from "postgres"
import { executeAutomationRuns, processAutomationEvents } from "./automation-worker.ts"
import { processGitHubDeliveries } from "./github-worker.ts"
import { deliverOutgoing, type HttpsTransport } from "./outgoing-worker.ts"
import { processRecurrences } from "./recurrence-worker.ts"

export type WorkerResult = {
  readonly recurrences: number
  readonly events: number
  readonly runs: number
  readonly deliveries: number
  readonly githubDeliveries: number
}

export class AutomationWorker {
  readonly #sql: Sql
  readonly #transport: HttpsTransport | undefined
  constructor(sql: Sql, transport?: HttpsTransport) {
    this.#sql = sql
    this.#transport = transport
  }
  async runOnce(now: Date, limit: number): Promise<WorkerResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
      throw new RangeError("worker limit must be between 1 and 1000")
    const recurrences = await processRecurrences(this.#sql, now, limit)
    const githubDeliveries = await processGitHubDeliveries(this.#sql, now, limit)
    const events = await processAutomationEvents(this.#sql, now, limit)
    const runs = await executeAutomationRuns(this.#sql, now, limit)
    const deliveries =
      this.#transport === undefined
        ? await deliverOutgoing(this.#sql, now, limit)
        : await deliverOutgoing(this.#sql, now, limit, this.#transport)
    return { recurrences, githubDeliveries, events, runs, deliveries }
  }
}
