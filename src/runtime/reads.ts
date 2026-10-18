import type { Sql } from "postgres"
import {
  RunInspectionResponseSchema,
  RuntimeActivityPageResponseSchema,
  RuntimeActivityResponseSchema,
  RuntimeArtifactPageResponseSchema,
  RuntimeArtifactResponseSchema,
  RuntimeReceiptPageResponseSchema,
  RuntimeReceiptResponseSchema,
} from "../contracts/runtime/index.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { RuntimeNotFoundError } from "./errors.ts"
import { requireInspectableRun } from "./subject-authority.ts"

export type RuntimeReadPage = { readonly limit: number; readonly after: string }

export class RuntimeReads {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  async inspect(principal: AuthenticatedPrincipal, runId: string) {
    return this.#sql.begin(async (transaction) => {
      await requireInspectableRun(transaction, principal, runId)
      const rows =
        await transaction`select id,workspace_id,installation_id,subject_ref,directive_ref,
        state,generation,depth,created_at::text,updated_at::text from runtime_runs
        where workspace_id=${principal.workspaceId} and id=${runId}`
      if (rows[0] === undefined) throw new RuntimeNotFoundError()
      return RunInspectionResponseSchema.parse(rows[0])
    })
  }

  async activity(principal: AuthenticatedPrincipal, runId: string, page: RuntimeReadPage) {
    return this.#sql.begin(async (transaction) => {
      await requireInspectableRun(transaction, principal, runId)
      const after = page.after === "" ? 0 : Number(page.after)
      const rows = await transaction`select id,generation,sequence,kind,actor_id "actorId",durable,
        body,references_json "references",created_at::text "createdAt" from runtime_activity
        where run_id=${runId} and sequence>${after} order by sequence limit ${page.limit + 1}`
      const items = rows.slice(0, page.limit).map((row) => RuntimeActivityResponseSchema.parse(row))
      return RuntimeActivityPageResponseSchema.parse({
        items,
        nextAfter: rows.length > page.limit ? String(items.at(-1)?.sequence) : null,
        hasMore: rows.length > page.limit,
      })
    })
  }

  async receipts(principal: AuthenticatedPrincipal, runId: string, page: RuntimeReadPage) {
    return this.#sql.begin(async (transaction) => {
      await requireInspectableRun(transaction, principal, runId)
      const rows = await transaction`select id,projection,created_at::text "createdAt",
        retention_until::text "retentionUntil" from retrieval_receipts where run_id=${runId}
        and id::text>${page.after} order by id::text limit ${page.limit + 1}`
      const items = rows.slice(0, page.limit).map((row) => RuntimeReceiptResponseSchema.parse(row))
      return RuntimeReceiptPageResponseSchema.parse({
        items,
        nextAfter: rows.length > page.limit ? items.at(-1)?.id : null,
        hasMore: rows.length > page.limit,
      })
    })
  }

  async artifacts(principal: AuthenticatedPrincipal, runId: string, page: RuntimeReadPage) {
    return this.#sql.begin(async (transaction) => {
      await requireInspectableRun(transaction, principal, runId)
      const rows =
        await transaction`select id,kind,media_type "mediaType",retention_class "retentionClass",
        digest,byte_size "byteSize",complete,created_at::text "createdAt" from runtime_artifacts
        where run_id=${runId} and id>${page.after} order by id limit ${page.limit + 1}`
      const items = rows.slice(0, page.limit).map((row) => RuntimeArtifactResponseSchema.parse(row))
      return RuntimeArtifactPageResponseSchema.parse({
        items,
        nextAfter: rows.length > page.limit ? items.at(-1)?.id : null,
        hasMore: rows.length > page.limit,
      })
    })
  }
}
