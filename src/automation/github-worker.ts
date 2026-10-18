import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import { R4CommandService } from "../pm/commands/service.ts"
import { resolveAutomationPrincipal } from "./principal.ts"

const DeliverySchema = z.strictObject({
  installation_id: z.string(),
  delivery_id: z.string(),
  event_name: z.string(),
  payload: z.record(z.string(), z.unknown()),
})
const IssuePayloadSchema = z.looseObject({
  action: z.string(),
  issue: z.looseObject({ number: z.number().int().positive(), title: z.string().min(1).max(200) }),
})
const MappingSchema = z.strictObject({
  entity_id: z.string(),
  workspace_id: z.string(),
  created_by: z.string(),
  current_revision: z.coerce.number().int().positive(),
  kind: z.literal("work_item"),
})

export async function processGitHubDeliveries(sql: Sql, now: Date, limit: number): Promise<number> {
  let processed = 0
  for (let index = 0; index < limit; index += 1) {
    try {
      const found = await sql.begin((transaction) => processOne(transaction, now))
      if (!found) break
      processed += 1
    } catch (error) {
      if (!(error instanceof GitHubDeliveryError)) throw error
      const failed = await failDelivery(sql, now, error)
      if (!failed) throw error
      processed += 1
    }
  }
  return processed
}

async function processOne(transaction: TransactionSql, now: Date): Promise<boolean> {
  const rows = await transaction`select installation_id,delivery_id,event_name,payload
    from github_webhook_deliveries where state in ('pending','failed')
      and available_at<=${now.toISOString()} order by available_at,installation_id,delivery_id
    for update skip locked limit 1`
  if (rows[0] === undefined) return false
  const delivery = DeliverySchema.parse(rows[0])
  try {
    await transaction`update github_webhook_deliveries set state='processing',attempts=attempts+1
      where installation_id=${delivery.installation_id} and delivery_id=${delivery.delivery_id}`
    await applyDelivery(transaction, delivery)
    await transaction`update github_webhook_deliveries set state='succeeded',processed_at=clock_timestamp(),
      last_error=null where installation_id=${delivery.installation_id} and delivery_id=${delivery.delivery_id}`
  } catch (error) {
    throw new GitHubDeliveryError(delivery.installation_id, delivery.delivery_id, error)
  }
  return true
}

async function applyDelivery(
  transaction: TransactionSql,
  delivery: z.infer<typeof DeliverySchema>,
): Promise<void> {
  if (delivery.event_name !== "issues") return
  const payload = IssuePayloadSchema.parse(delivery.payload)
  const mappings = await transaction`select mapping.entity_id,installation.workspace_id,
    installation.created_by,entity.current_revision,entity.kind from github_mappings mapping
    join github_installations installation on installation.id=mapping.installation_id
    join entities entity on entity.id=mapping.entity_id
    where mapping.installation_id=${delivery.installation_id}
      and mapping.github_number=${payload.issue.number}`
  if (mappings[0] === undefined) return
  const mapping = MappingSchema.parse(mappings[0])
  const principal = await resolveAutomationPrincipal(
    transaction,
    mapping.workspace_id,
    mapping.created_by,
  )
  const key = `github:${delivery.installation_id}:${delivery.delivery_id}`
  await new R4CommandService(transaction).execute({
    workspaceId: mapping.workspace_id,
    principal,
    commandId: key,
    idempotencyKey: key,
    baseRevision: mapping.current_revision,
    action: "work-item.update",
    route: "github-webhook-worker",
    resourceId: mapping.entity_id,
    parentId: null,
    payload: { title: payload.issue.title },
  })
}

async function failDelivery(sql: Sql, now: Date, error: GitHubDeliveryError): Promise<boolean> {
  const message = error.cause instanceof Error ? error.cause.message : "GitHub delivery failed"
  const rows = await sql`update github_webhook_deliveries set
    attempts=attempts+1,state=case when attempts+1>=5 then 'dead_letter' else 'failed' end,
    last_error=${message},
    available_at=${new Date(now.getTime() + 2_000).toISOString()}
    where installation_id=${error.installationId} and delivery_id=${error.deliveryId}
      and processed_at is null
    returning delivery_id`
  return rows.length === 1
}

class GitHubDeliveryError extends Error {
  override readonly name = "GitHubDeliveryError"
  readonly installationId: string
  readonly deliveryId: string
  override readonly cause: unknown
  constructor(installationId: string, deliveryId: string, cause: unknown) {
    super("GitHub delivery failed", { cause })
    this.installationId = installationId
    this.deliveryId = deliveryId
    this.cause = cause
  }
}
