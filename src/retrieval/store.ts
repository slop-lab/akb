import { createHash, randomUUID } from "node:crypto"
import type { TransactionSql } from "postgres"
import { z } from "zod"
import type { RetrievalProjection, RetrievalRequest } from "../contracts/runtime/index.ts"
import type { RunPrincipal } from "../runtime/principal.ts"
import { estimatedTokens, projectEntity } from "./projection.ts"
import type { RetrievalProvider } from "./providers.ts"

const SourceRowSchema = z.strictObject({
  id: z.string(),
  kind: z.string(),
  revision: z.coerce.number().int().positive(),
  lifecycle: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
})
const SnapshotRowSchema = z.strictObject({
  id: z.uuid(),
  expires_at: z.string(),
  authority_epoch: z.coerce.number().int().positive(),
})
const EntryRowSchema = z.strictObject({
  ordinal: z.coerce.number().int().positive(),
  entity_id: z.string(),
  source_revision: z.coerce.number().int().positive(),
  kind: z.string(),
})

export type StoredEntry = z.infer<typeof EntryRowSchema>
export type ProjectedEntry = {
  readonly ordinal: number
  readonly entityId: string
  readonly sourceRevision: number
  readonly value: Readonly<Record<string, unknown>>
  readonly estimatedTokens: number
}

export async function materializeSnapshot(
  transaction: TransactionSql,
  principal: RunPrincipal,
  request: RetrievalRequest,
  providers: readonly RetrievalProvider[],
): Promise<{
  readonly id: string
  readonly expiresAt: string
  readonly authorityEpoch: number
  readonly matched: number
}> {
  const sources: z.infer<typeof SourceRowSchema>[] = []
  for (const provider of providers) {
    const rows = await transaction`with authorized as materialized (
        select e.id,e.kind,e.current_revision revision,e.lifecycle,r.canonical_snapshot snapshot
        from entities e join entity_revisions r on r.entity_id=e.id and r.revision=e.current_revision
        where e.workspace_id=${principal.workspaceId} and e.kind=${provider.kind}
          and e.lifecycle<>'deleted' and entity_access_allowed(e.workspace_id,e.id,
            ${principal.principalId},${provider.readPermission})
      ) select * from authorized where
        (${request.operation}<>'search_entities' or ${request.query}='' or
          lower(snapshot::text) like ${`%${request.query.toLowerCase()}%`})
        and (${request.ids.length}=0 or id=any(${transaction.array([...request.ids])}))`
    sources.push(...rows.map((row) => SourceRowSchema.parse(row)))
  }
  sources.sort((left, right) => left.id.localeCompare(right.id))
  const authorityRows = await transaction<{ readonly epoch: number }[]>`
    select epoch::integer from workspace_authority_epochs where workspace_id=${principal.workspaceId} for share`
  const authorityEpoch = authorityRows[0]?.epoch
  if (authorityEpoch === undefined) throw new TypeError("workspace authority epoch is missing")
  const id = randomUUID()
  const queryHash = createHash("sha256").update(JSON.stringify(request)).digest("hex")
  const snapshotRows = await transaction`insert into runtime_context_snapshots
    (id,run_id,generation,authority_epoch,query_hash,expires_at) values
    (${id},${principal.runId},${principal.generation},${authorityEpoch},${queryHash},
     clock_timestamp()+interval '15 minutes')
    returning id,to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') expires_at,
      authority_epoch`
  const snapshot = SnapshotRowSchema.parse(snapshotRows[0])
  for (const [index, source] of sources.entries()) {
    const provider = providers.find((candidate) => candidate.kind === source.kind)
    if (provider === undefined) continue
    const tokens = estimatedTokens(projectEntity(source, provider, request.projection))
    await transaction`insert into runtime_context_entries
      (snapshot_id,ordinal,entity_id,source_revision,kind,estimated_tokens) values
      (${id},${index + 1},${source.id},${source.revision},${source.kind},${tokens})`
  }
  return {
    id: snapshot.id,
    expiresAt: snapshot.expires_at,
    authorityEpoch,
    matched: sources.length,
  }
}

export async function readStoredEntries(
  transaction: TransactionSql,
  snapshotId: string,
  after: number,
): Promise<readonly StoredEntry[]> {
  const rows = await transaction`select ordinal,entity_id,source_revision,kind
    from runtime_context_entries where snapshot_id=${snapshotId}::uuid and ordinal>${after}
    order by ordinal limit 101`
  return rows.map((row) => EntryRowSchema.parse(row))
}

export async function projectAuthorizedEntry(
  transaction: TransactionSql,
  principal: RunPrincipal,
  entry: StoredEntry,
  provider: RetrievalProvider,
  projection: RetrievalProjection,
): Promise<ProjectedEntry | undefined> {
  const rows = await transaction`select e.id,e.kind,${entry.source_revision}::bigint revision,
      e.lifecycle,r.canonical_snapshot snapshot from entities e join entity_revisions r
      on r.entity_id=e.id and r.revision=${entry.source_revision}
    where e.workspace_id=${principal.workspaceId} and e.id=${entry.entity_id}
      and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},${provider.readPermission})`
  if (rows[0] === undefined) return undefined
  const source = SourceRowSchema.parse(rows[0])
  const value = projectEntity(source, provider, projection)
  return {
    ordinal: entry.ordinal,
    entityId: entry.entity_id,
    sourceRevision: entry.source_revision,
    value,
    estimatedTokens: estimatedTokens(value),
  }
}

export async function storeReceipt(
  transaction: TransactionSql,
  principal: RunPrincipal,
  snapshotId: string,
  queryHash: string,
  projection: RetrievalProjection,
  entries: readonly ProjectedEntry[],
): Promise<string> {
  const receiptId = randomUUID()
  await transaction`insert into retrieval_receipts
    (id,workspace_id,principal_id,run_id,snapshot_id,query_hash,projection,retention_until)
    values (${receiptId},${principal.workspaceId},${principal.principalId},${principal.runId},
      ${snapshotId}::uuid,${queryHash},${projection},clock_timestamp()+interval '90 days')`
  for (const entry of entries) {
    await transaction`insert into retrieval_receipt_entries
      (receipt_id,entity_id,source_revision,projection) values
      (${receiptId},${entry.entityId},${entry.sourceRevision},${projection})`
  }
  return receiptId
}
