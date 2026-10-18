import type { Sql } from "postgres"
import {
  AnalyticsQuerySchema,
  type AnalyticsResponse,
  AnalyticsResponseSchema,
} from "../contracts/automation/index.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"

export class AutomationAnalytics {
  readonly #sql: Sql
  constructor(sql: Sql) {
    this.#sql = sql
  }

  async query(principal: AuthenticatedPrincipal, input: unknown): Promise<AnalyticsResponse> {
    const value = AnalyticsQuerySchema.parse(input)
    return AnalyticsResponseSchema.parse({
      metric: value.metric,
      value: await this.#count(principal, value),
      from: value.from,
      to: value.to,
    })
  }

  async #count(
    principal: AuthenticatedPrincipal,
    query: ReturnType<typeof AnalyticsQuerySchema.parse>,
  ): Promise<number> {
    switch (query.metric) {
      case "throughput":
        return count(this.#sql`select count(*)::integer value from work_item_pm pm
          join entities entity on entity.id=pm.work_item_id
          where pm.workspace_id=${principal.workspaceId} and pm.completed_at>=${query.from}
            and pm.completed_at<${query.to} and entity_access_allowed(entity.workspace_id,entity.id,
              ${principal.principalId},'work.read')`)
      case "overdue":
        return count(this.#sql`select count(*)::integer value from work_item_pm pm
          join entities entity on entity.id=pm.work_item_id join work_items work on work.id=pm.work_item_id
          where pm.workspace_id=${principal.workspaceId} and pm.due_date<${query.to}::timestamptz
            and work.state not in ('completed','canceled') and entity_access_allowed(entity.workspace_id,
              entity.id,${principal.principalId},'work.read')`)
      case "blocked":
        return count(this.#sql`select count(distinct relation.to_entity_id)::integer value
          from relations relation join entities relation_entity on relation_entity.id=relation.id
          where relation.workspace_id=${principal.workspaceId} and relation.relation_type='blocks'
            and relation.valid_to is null and entity_access_allowed(relation_entity.workspace_id,
              relation_entity.id,${principal.principalId},'work.read')`)
      case "run_outcomes":
        return count(this.#sql`select count(*)::integer value from runtime_runs run
          join entities subject on subject.workspace_id=run.workspace_id and subject.id=run.subject_ref
          join entity_kind_registry registry on registry.kind=subject.kind
          where run.workspace_id=${principal.workspaceId} and run.created_at>=${query.from}
            and run.created_at<${query.to} and exists(select 1 from membership_permissions permission
              where permission.workspace_id=run.workspace_id and permission.principal_id=${principal.principalId}
                and permission.permission='run.inspect') and entity_access_allowed(subject.workspace_id,
              subject.id,${principal.principalId},registry.read_permission)`)
      case "proposal_acceptance":
        return count(this.#sql`select count(*)::integer value from knowledge_proposals proposal
          join entities entity on entity.id=proposal.id where proposal.workspace_id=${principal.workspaceId}
            and proposal.status='accepted' and proposal.created_at>=${query.from}
            and proposal.created_at<${query.to} and entity_access_allowed(entity.workspace_id,
              entity.id,${principal.principalId},'review.read')`)
      default:
        return assertNever(query.metric)
    }
  }
}

async function count(pending: PromiseLike<readonly { readonly value: number }[]>): Promise<number> {
  const rows = await pending
  return rows[0]?.value ?? 0
}
function assertNever(value: never): never {
  throw new TypeError(`unsupported metric:${value}`)
}
