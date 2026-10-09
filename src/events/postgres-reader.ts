import type { Sql } from "postgres"
import { authorizeWorkspace } from "../identity/authorize.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import type { WorkItemEvent } from "../work-items/model.ts"
import { parseEvent } from "../work-items/postgres-records.ts"

export type EventPage = {
  readonly events: readonly WorkItemEvent[]
  readonly hasMore: boolean
  readonly nextAfter: number
}

export class PostgresWorkspaceEventReader {
  readonly #sql: Sql
  readonly #context: AuthenticatedPrincipal

  constructor(sql: Sql, context: AuthenticatedPrincipal) {
    this.#sql = sql
    this.#context = context
  }

  async read(workspaceId: string, after: number, limit: number): Promise<EventPage> {
    return this.#sql.begin("isolation level read committed", async (transaction) => {
      await authorizeWorkspace(transaction, this.#context, "work.read", workspaceId)
      const rows = await transaction`select * from domain_events
        where workspace_id = ${workspaceId} and sequence > ${after}
        order by sequence limit ${limit + 1}`
      const events = rows.slice(0, limit).map(parseEvent)
      return Object.freeze({
        events: Object.freeze(events),
        hasMore: rows.length > limit,
        nextAfter: events.at(-1)?.sequence ?? after,
      })
    })
  }
}
