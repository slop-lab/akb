import type { Sql } from "postgres"
import { PermissionDeniedError } from "../identity/authorization-errors.ts"
import { authorizeWorkspace } from "../identity/authorize.ts"
import { requireCompletePrivateSpaceRead } from "../identity/space-authorization.ts"
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
      const accessible = await requireCompletePrivateSpaceRead(transaction, this.#context)
      const restricted = await transaction`select 1 from entities e
        join entity_acl_policies p on p.entity_id = e.id and p.mode = 'restricted'
        where e.workspace_id = ${workspaceId} and e.kind = 'work_item'
          and not entity_access_allowed(e.workspace_id, e.id,
            ${this.#context.principalId}, 'work.read') limit 1`
      if (restricted.length > 0) throw new PermissionDeniedError()
      const rows = await transaction`select e.* from domain_events e
        join work_items w on w.id = e.subject_id and w.workspace_id = e.workspace_id
          and w.space_id is not distinct from e.space_id
        where e.workspace_id = ${workspaceId} and e.sequence > ${after}
          and (w.space_id is null or w.space_id = any(${transaction.array([...accessible])}))
        order by e.sequence limit ${limit + 1}`
      const events = rows.slice(0, limit).map(parseEvent)
      return Object.freeze({
        events: Object.freeze(events),
        hasMore: rows.length > limit,
        nextAfter: events.at(-1)?.sequence ?? after,
      })
    })
  }
}
