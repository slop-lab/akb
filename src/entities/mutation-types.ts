import type { TransactionSql } from "postgres"
import type { AuthenticatedPrincipal, WorkPermission } from "../identity/types.ts"

export type JsonObject = Readonly<Record<string, unknown>>

export type MutationInput = {
  readonly workspaceId: string
  readonly principal: AuthenticatedPrincipal
  readonly commandId: string
  readonly idempotencyKey: string
  readonly baseRevision: number | null
  readonly action: string
  readonly route: string
  readonly permission: WorkPermission
  readonly targetEntityId: string | null
  readonly resourceId: string | null
  readonly parentId: string | null
  readonly payload: unknown
}

export type MutationRecord = {
  readonly entityId: string
  readonly kind: string
  readonly revision: number
  readonly schemaVersion: string
  readonly eventType:
    | "entity.created"
    | "entity.updated"
    | "entity.archived"
    | "entity.restored"
    | "acl.changed"
    | "relation.created"
    | "relation.updated"
    | "relation.archived"
    | "comment.created"
    | "comment.updated"
  readonly snapshot: JsonObject
  readonly eventData: JsonObject
  readonly result: JsonObject
  readonly postEvent?: (eventId: string, occurredAt: string) => Promise<void>
}

export type MutationCallback = (
  transaction: TransactionSql,
  revision: number,
) => Promise<MutationRecord>

export type MutationResult = {
  readonly commandId: string
  readonly eventId: string
  readonly result: JsonObject
  readonly revision: number
  readonly replayed: boolean
  readonly warnings: readonly string[]
}
