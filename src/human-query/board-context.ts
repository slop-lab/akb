import type { TransactionSql } from "postgres"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import type { CursorBinding } from "./cursor.ts"

export type BoardQueryContext = {
  readonly principal: AuthenticatedPrincipal
  readonly queryHash: string
  readonly sortHash: string
  readonly epoch: number
}

export type BoardSnapshotRead = {
  readonly transaction: TransactionSql
  readonly principal: AuthenticatedPrincipal
  readonly binding: CursorBinding
}

export type BoardPageOptions = { readonly size: number; readonly signingKey: Uint8Array }

export type BoardBindingOptions = {
  readonly pageSize: number
  readonly expiresAt: string
  readonly group: string | null
}
