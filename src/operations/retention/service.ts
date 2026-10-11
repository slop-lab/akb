import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"

export const RETENTION_RESOURCES = [
  "entities",
  "entity_revisions",
  "entity_events",
  "comments",
  "query_snapshots",
  "import_bookkeeping",
] as const

export const RetentionResourceSchema = z.enum(RETENTION_RESOURCES)
export type RetentionResource = z.infer<typeof RetentionResourceSchema>

const PolicyRowSchema = z.strictObject({
  resource: RetentionResourceSchema,
  mode: z.enum(["keep_forever", "purge_after"]),
})
const IdRowSchema = z.strictObject({ id: z.string() })

export type RetentionResourceReport = {
  readonly resource: RetentionResource
  readonly mode: "keep_forever" | "purge_after"
  readonly eligibleCount: number
  readonly operatorIds?: readonly string[]
}

export type RetentionDryRunReport = {
  readonly dryRun: true
  readonly workspaceId: string
  readonly evaluatedAt: string
  readonly resources: readonly RetentionResourceReport[]
}

export async function inspectRetention(
  sql: Sql,
  input: {
    readonly workspaceId: string
    readonly resources: readonly RetentionResource[]
    readonly now?: Date
  },
): Promise<RetentionDryRunReport> {
  const workspaceId = z.string().trim().min(1).parse(input.workspaceId)
  const resources = z
    .array(RetentionResourceSchema)
    .min(1)
    .parse([...new Set(input.resources)])
  const now = input.now ?? new Date()
  return sql.begin("read only isolation level repeatable read", async (transaction) => {
    const workspaces = await transaction`select id from workspaces where id=${workspaceId}`
    if (workspaces.length !== 1) throw new RetentionWorkspaceNotFoundError(workspaceId)
    const policyRows = await transaction`select resource,mode from retention_policies
      where resource=any(${transaction.array(resources)}) order by resource`
    const policies = new Map(
      policyRows.map((row) => {
        const policy = PolicyRowSchema.parse(row)
        return [policy.resource, policy.mode] as const
      }),
    )
    const reports: RetentionResourceReport[] = []
    for (const resource of resources) {
      const mode = policies.get(resource)
      if (mode === undefined) throw new RetentionPolicyMissingError(resource)
      if (mode === "keep_forever") {
        reports.push({ resource, mode, eligibleCount: 0 })
        continue
      }
      const rows = await eligibleIds(transaction, workspaceId, resource, now)
      reports.push({
        resource,
        mode,
        eligibleCount: rows.length,
        operatorIds: Object.freeze(rows.map((row) => IdRowSchema.parse(row).id)),
      })
    }
    return Object.freeze({
      dryRun: true,
      workspaceId,
      evaluatedAt: now.toISOString(),
      resources: Object.freeze(reports),
    })
  })
}

async function eligibleIds(
  transaction: TransactionSql,
  workspaceId: string,
  resource: RetentionResource,
  now: Date,
): Promise<readonly unknown[]> {
  if (resource === "query_snapshots") {
    return transaction`select s.id::text id from human_query_snapshots s
      join retention_policies p on p.resource='query_snapshots' and p.mode='purge_after'
      where s.workspace_id=${workspaceId} and s.expires_at<=${now}
        and s.created_at<=${now}-p.retention_interval order by s.id`
  }
  if (resource === "import_bookkeeping") {
    return transaction`select b.import_id::text id from import_batches b
      join retention_policies p on p.resource='import_bookkeeping' and p.mode='purge_after'
      where b.workspace_id=${workspaceId} and b.state='validated'
        and b.validation_expires_at<=${now} and b.created_at<=${now}-p.retention_interval
      order by b.import_id`
  }
  return []
}

export class RetentionWorkspaceNotFoundError extends Error {
  override readonly name = "RetentionWorkspaceNotFoundError"
  readonly workspaceId: string

  constructor(workspaceId: string) {
    super("retention workspace was not found")
    this.workspaceId = workspaceId
  }
}

export class RetentionPolicyMissingError extends Error {
  override readonly name = "RetentionPolicyMissingError"
  readonly resource: RetentionResource

  constructor(resource: RetentionResource) {
    super("retention policy is missing")
    this.resource = resource
  }
}
