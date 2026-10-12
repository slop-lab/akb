import type { TransactionSql } from "postgres"
import { z } from "zod"
import type { CursorBinding } from "./cursor.ts"

const StoredSnapshotSchema = z.strictObject({
  workspace_id: z.string(),
  principal_id: z.string(),
  credential_id: z.string(),
  query_hash: z.string(),
  sort_hash: z.string(),
  authority_hash: z.string(),
  matched: z.number().int().nonnegative(),
  expired: z.boolean(),
  expires_at: z.string(),
})

export class SnapshotConflictError extends Error {
  override readonly name = "SnapshotConflictError"
  readonly code: "snapshot_stale" | "snapshot_expired"

  constructor(code: "snapshot_stale" | "snapshot_expired") {
    super(code)
    this.code = code
  }
}

export async function validateStoredSnapshot(
  transaction: TransactionSql,
  binding: CursorBinding,
): Promise<{ readonly matched: number }> {
  const rows =
    await transaction`select workspace_id,principal_id,credential_id,query_hash,sort_hash,
      authority_hash,matched::integer,expires_at<=clock_timestamp() expired,
      to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') expires_at
    from human_query_snapshots where id=${binding.snapshotId}::uuid for share`
  const row = rows[0]
  if (row === undefined) throw new SnapshotConflictError("snapshot_stale")
  const snapshot = StoredSnapshotSchema.parse(row)
  if (snapshot.expired) throw new SnapshotConflictError("snapshot_expired")
  if (
    snapshot.workspace_id !== binding.workspaceId ||
    snapshot.principal_id !== binding.principalId ||
    snapshot.credential_id !== binding.credentialId ||
    snapshot.query_hash !== binding.queryHash ||
    snapshot.sort_hash !== binding.sortHash ||
    snapshot.authority_hash !== binding.authorityHash ||
    snapshot.expires_at !== binding.expiresAt
  ) {
    throw new SnapshotConflictError("snapshot_stale")
  }
  return { matched: snapshot.matched }
}
