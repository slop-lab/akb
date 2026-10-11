import type { Sql } from "postgres"
import { z } from "zod"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
  WorkspaceNotFoundError,
} from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { type EntityEvent, parseEntityEvent } from "./entity-event.ts"

export type EntityEventPage = {
  readonly events: readonly EntityEvent[]
  readonly hasMore: boolean
  readonly nextAfter: number
}

export class EntityEventReader {
  readonly #sql: Sql
  readonly #principal: AuthenticatedPrincipal

  constructor(sql: Sql, principal: AuthenticatedPrincipal) {
    this.#sql = sql
    this.#principal = principal
  }

  async read(workspaceId: string, after: number, limit: number): Promise<EntityEventPage> {
    return this.#sql.begin("isolation level read committed", async (transaction) => {
      if (!(await lockAuthenticatedPrincipal(transaction, this.#principal))) {
        throw new AuthenticationRequiredError()
      }
      if (workspaceId !== this.#principal.workspaceId) throw new WorkspaceNotFoundError()
      const denied = await transaction`select 1 from entities e
        where e.workspace_id=${workspaceId} and not entity_access_allowed(
          e.workspace_id,e.id,${this.#principal.principalId},case
            when e.kind='project' then 'project.read'
            when e.kind in ('space','workflow','workflow_state') then 'space.read'
            when e.kind='saved_view' then 'view.read'
            when e.kind in ('work_item','label','relation','thread','comment') then 'work.read'
            else '__unsupported_read_permission__' end) limit 1`
      if (denied.length > 0) throw new PermissionDeniedError()
      const rows = await transaction`select id,workspace_id,sequence,event_type,subject_kind,
        subject_id,subject_revision,occurred_at,actor_id,payload_schema,data
        from entity_events_v1 where workspace_id=${workspaceId} and sequence>${after}
        order by sequence limit ${limit + 1}`
      const events = rows.slice(0, limit).map(parseEntityEvent)
      return Object.freeze({
        events: Object.freeze(events),
        hasMore: rows.length > limit,
        nextAfter: z
          .number()
          .int()
          .nonnegative()
          .parse(events.at(-1)?.sequence ?? after),
      })
    })
  }
}
