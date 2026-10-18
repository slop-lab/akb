import { createHash } from "node:crypto"
import type { TransactionSql } from "postgres"
import { z } from "zod"
import type { DeltaRequest } from "../contracts/runtime/index.ts"
import { RuntimeConflictError } from "../runtime/errors.ts"
import type { RunPrincipal } from "../runtime/principal.ts"
import { estimatedTokens } from "./projection.ts"
import type { RetrievalProviderRegistry } from "./providers.ts"
import { type ProjectedEntry, storeReceipt } from "./store.ts"

const DeltaRowSchema = z.strictObject({
  entity_id: z.string(),
  source_revision: z.coerce.number().int(),
  projection: z.string(),
  snapshot_id: z.string(),
  kind: z.string(),
  current_revision: z.coerce.number().int(),
})

export async function readRetrievalDelta(
  transaction: TransactionSql,
  principal: RunPrincipal,
  request: DeltaRequest,
  registry: RetrievalProviderRegistry,
): Promise<unknown> {
  const rows = await transaction`select e.entity_id,e.source_revision,r.projection,r.snapshot_id,
      n.kind,n.current_revision from retrieval_receipt_entries e join retrieval_receipts r on r.id=e.receipt_id
    join entities n on n.id=e.entity_id where r.id=${request.sinceReceipt}::uuid
      and r.workspace_id=${principal.workspaceId} and r.principal_id=${principal.principalId}
      and r.run_id=${principal.runId} order by e.entity_id`
  if (rows.length === 0) throw new RuntimeConflictError("receipt_invalid")
  const changed: Readonly<Record<string, unknown>>[] = []
  const nextEntries: ProjectedEntry[] = []
  let permissionOmitted = false
  let deferred = 0
  let tokens = 0
  const parsedRows = rows.map((row) => DeltaRowSchema.parse(row))
  for (const row of parsedRows) {
    if (!request.kinds.includes(row.kind)) continue
    const provider = registry.get(row.kind)
    if (provider === undefined) continue
    const access = await transaction`select 1 from entities e where e.id=${row.entity_id}
      and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},${provider.readPermission})`
    if (access.length !== 1) {
      permissionOmitted = true
      continue
    }
    const value = {
      id: row.entity_id,
      kind: row.kind,
      fromRevision: row.source_revision,
      toRevision: row.current_revision,
      changedFields: "unknown",
    }
    const changedTokens = estimatedTokens(value)
    const isChanged = row.source_revision !== row.current_revision
    const withinBudget =
      changed.length < request.budget.maxItems && tokens + changedTokens <= request.budget.maxTokens
    if (isChanged && withinBudget) {
      changed.push(value)
      tokens += changedTokens
    } else if (isChanged) {
      deferred += 1
    }
    nextEntries.push({
      ordinal: nextEntries.length + 1,
      entityId: row.entity_id,
      sourceRevision: isChanged && !withinBudget ? row.source_revision : row.current_revision,
      value: {},
      estimatedTokens: 0,
    })
  }
  const snapshotId = parsedRows[0]?.snapshot_id
  if (snapshotId === undefined) throw new RuntimeConflictError("receipt_invalid")
  const nextReceipt = await storeReceipt(
    transaction,
    principal,
    snapshotId,
    createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    request.projection,
    nextEntries,
  )
  return {
    changed,
    created: [],
    deleted: [],
    newRelations: [],
    nextReceipt,
    omitted: [
      ...(permissionOmitted
        ? [{ category: "restricted", count: "unknown", reason: "permission" }]
        : []),
      ...(deferred === 0
        ? []
        : [{ category: "authorized_object", count: deferred, reason: "budget" }]),
    ],
  }
}
