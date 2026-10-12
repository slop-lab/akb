import { createHash } from "node:crypto"
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
} from "../human-query/cursor.ts"
import { SnapshotConflictError } from "../human-query/service.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"

const SEARCH_GROUP = "r4-search"
const SEARCH_SORT_HASH = digest("r4-search-rank-v1")

export type SearchAuthority = {
  readonly epoch: number
}

export function searchQueryHash(text: string, kinds: readonly string[]): string {
  return digest({ protocol: SEARCH_GROUP, text, kinds })
}

export function initialBinding(input: {
  readonly snapshotId: string
  readonly principal: AuthenticatedPrincipal
  readonly queryHash: string
  readonly pageSize: number
  readonly epoch: number
  readonly expiresAt: string
}): CursorBinding {
  return {
    snapshotId: input.snapshotId,
    ordinal: 0,
    group: SEARCH_GROUP,
    principalId: input.principal.principalId,
    credentialId: input.principal.credentialId,
    workspaceId: input.principal.workspaceId,
    queryHash: input.queryHash,
    sortHash: SEARCH_SORT_HASH,
    pageSize: input.pageSize,
    authorityHash: authorityHash(input.epoch),
    authorityEpoch: input.epoch,
    expiresAt: input.expiresAt,
  }
}

export function continuationBinding(input: {
  readonly cursor: string
  readonly signingKey: Uint8Array
  readonly principal: AuthenticatedPrincipal
  readonly queryHash: string
  readonly pageSize: number
  readonly authority: SearchAuthority
}): CursorBinding {
  const binding = decodeCursor(input.cursor, input.signingKey)
  if (
    binding.group !== SEARCH_GROUP ||
    binding.principalId !== input.principal.principalId ||
    binding.credentialId !== input.principal.credentialId ||
    binding.workspaceId !== input.principal.workspaceId ||
    binding.queryHash !== input.queryHash ||
    binding.sortHash !== SEARCH_SORT_HASH ||
    binding.pageSize !== input.pageSize ||
    binding.authorityEpoch !== input.authority.epoch ||
    binding.authorityHash !== authorityHash(input.authority.epoch)
  ) {
    throw new SnapshotConflictError("snapshot_stale")
  }
  return binding
}

export function nextSearchCursor(
  binding: CursorBinding,
  ordinal: number,
  signingKey: Uint8Array,
): string {
  return encodeCursor({ ...binding, ordinal }, signingKey)
}

export { InvalidCursorError }

function authorityHash(epoch: number): string {
  return digest({ protocol: SEARCH_GROUP, epoch })
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
