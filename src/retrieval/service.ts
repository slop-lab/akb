import { createHash } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import type { DeltaRequest, RetrievalRequest } from "../contracts/runtime/index.ts"
import { RuntimeConflictError } from "../runtime/errors.ts"
import type { RunPrincipal } from "../runtime/principal.ts"
import { requireRunFence } from "../runtime/principal.ts"
import { decodeRetrievalCursor, encodeRetrievalCursor } from "./cursor.ts"
import { readRetrievalDelta } from "./delta.ts"
import { RetrievalProviderRegistry } from "./providers.ts"
import {
  materializeSnapshot,
  type ProjectedEntry,
  projectAuthorizedEntry,
  readStoredEntries,
  storeReceipt,
} from "./store.ts"

const ContinuationRowSchema = z.strictObject({
  id: z.string(),
  expires_at: z.string(),
  authority_epoch: z.coerce.number().int(),
  matched: z.coerce.number().int(),
  current_epoch: z.coerce.number().int(),
})

export class RetrievalService {
  readonly #sql: Sql
  readonly #signingKey: Uint8Array
  readonly #registry: RetrievalProviderRegistry

  constructor(sql: Sql, signingKey: Uint8Array, registry = new RetrievalProviderRegistry()) {
    if (signingKey.byteLength < 32) throw new RangeError("retrieval signing key requires 32 bytes")
    this.#sql = sql
    this.#signingKey = signingKey
    this.#registry = registry
  }

  async retrieve(principal: RunPrincipal, request: RetrievalRequest): Promise<unknown> {
    return this.#sql.begin(async (transaction) => {
      await requireRunFence(transaction, principal, principal.generation, "context.read")
      const providers = this.#registry.resolve(request.kinds)
      const queryHash = createHash("sha256")
        .update(JSON.stringify({ ...request, cursor: null }))
        .digest("hex")
      const snapshot =
        request.cursor === null
          ? await materializeSnapshot(transaction, principal, request, providers)
          : await this.#continuation(transaction, principal, request, queryHash)
      const after =
        request.cursor === null
          ? 0
          : decodeRetrievalCursor(request.cursor, this.#signingKey).ordinal
      const stored = await readStoredEntries(transaction, snapshot.id, after)
      const returned: ProjectedEntry[] = []
      let tokens = 0
      let considered = after
      let tooLarge = 0
      let permissionOmitted = false
      for (const entry of stored) {
        if (returned.length >= request.budget.maxItems) break
        const provider = this.#registry.get(entry.kind)
        if (provider === undefined) {
          considered = entry.ordinal
          continue
        }
        const projected = await projectAuthorizedEntry(
          transaction,
          principal,
          entry,
          provider,
          request.projection,
        )
        if (projected === undefined) {
          considered = entry.ordinal
          permissionOmitted = true
          continue
        }
        if (projected.estimatedTokens > request.budget.maxTokens) {
          considered = entry.ordinal
          tooLarge += 1
          continue
        }
        if (tokens + projected.estimatedTokens > request.budget.maxTokens) break
        returned.push(projected)
        tokens += projected.estimatedTokens
        considered = entry.ordinal
      }
      const hasMore = considered < snapshot.matched
      const receiptId = await storeReceipt(
        transaction,
        principal,
        snapshot.id,
        queryHash,
        request.projection,
        returned,
      )
      const omitted = [
        ...(tooLarge === 0
          ? []
          : [
              {
                category: "authorized_object",
                count: tooLarge,
                reason: "too_large",
                expansionHandle: `snapshot:${snapshot.id}`,
              },
            ]),
        ...(permissionOmitted
          ? [{ category: "restricted", count: "unknown", reason: "permission" }]
          : []),
        ...(hasMore
          ? [
              {
                category: "authorized_object",
                count: snapshot.matched - considered,
                reason: "budget",
                expansionHandle: `snapshot:${snapshot.id}`,
              },
            ]
          : []),
      ]
      return {
        snapshotId: snapshot.id,
        items: returned.map((entry) => ({
          ...entry.value,
          estimatedTokens: entry.estimatedTokens,
        })),
        completeness: {
          returned: returned.length,
          matched: permissionOmitted ? "unknown" : snapshot.matched,
          truncated: hasMore || tooLarge > 0 || permissionOmitted,
        },
        omitted,
        nextCursor: hasMore
          ? encodeRetrievalCursor(
              {
                snapshotId: snapshot.id,
                runId: principal.runId,
                generation: principal.generation,
                queryHash,
                projection: request.projection,
                maxItems: request.budget.maxItems,
                maxTokens: request.budget.maxTokens,
                ordinal: considered,
                authorityEpoch: snapshot.authorityEpoch,
                expiresAt: snapshot.expiresAt,
              },
              this.#signingKey,
            )
          : null,
        estimatedTokens: tokens,
        receiptId,
        warnings: [],
      }
    })
  }

  async delta(principal: RunPrincipal, request: DeltaRequest): Promise<unknown> {
    return this.#sql.begin(async (transaction) => {
      await requireRunFence(transaction, principal, principal.generation, "context.read")
      return readRetrievalDelta(transaction, principal, request, this.#registry)
    })
  }

  async #continuation(
    transaction: TransactionSql,
    principal: RunPrincipal,
    request: RetrievalRequest,
    queryHash: string,
  ): Promise<{
    readonly id: string
    readonly expiresAt: string
    readonly authorityEpoch: number
    readonly matched: number
  }> {
    if (request.cursor === null) throw new RuntimeConflictError("cursor_invalid")
    const cursor = decodeRetrievalCursor(request.cursor, this.#signingKey)
    if (
      cursor.runId !== principal.runId ||
      cursor.generation !== principal.generation ||
      cursor.queryHash !== queryHash ||
      cursor.projection !== request.projection ||
      cursor.maxItems !== request.budget.maxItems ||
      cursor.maxTokens !== request.budget.maxTokens
    ) {
      throw new RuntimeConflictError("cursor_invalid")
    }
    const rows = await transaction`select s.id,
        to_char(s.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') expires_at,
        s.authority_epoch,(select count(*)::integer from runtime_context_entries i
          where i.snapshot_id=s.id) matched,a.epoch::integer current_epoch
      from runtime_context_snapshots s join runtime_runs r on r.id=s.run_id
      join workspace_authority_epochs a on a.workspace_id=r.workspace_id
      where s.id=${cursor.snapshotId}::uuid and s.run_id=${principal.runId}
        and s.generation=${principal.generation}`
    if (rows[0] === undefined) throw new RuntimeConflictError("snapshot_expired")
    const row = ContinuationRowSchema.parse(rows[0])
    if (new Date(row.expires_at) <= new Date()) {
      throw new RuntimeConflictError("snapshot_expired")
    }
    const authorityEpoch = Number(row.authority_epoch)
    if (authorityEpoch !== Number(row.current_epoch) || authorityEpoch !== cursor.authorityEpoch) {
      throw new RuntimeConflictError("cursor_invalid")
    }
    return {
      id: cursor.snapshotId,
      expiresAt: row.expires_at,
      authorityEpoch,
      matched: Number(row.matched),
    }
  }
}
