import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import { EntityNotFoundError } from "../entities/errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"

type QuerySql = Sql | TransactionSql

const ProgressRowSchema = z.strictObject({
  item_count: z.coerce.number().int().nonnegative(),
  completed_count: z.coerce.number().int().nonnegative(),
  estimated_count: z.coerce.number().int().nonnegative(),
  total_estimate: z.coerce.number().nonnegative(),
  completed_estimate: z.coerce.number().nonnegative(),
  blocked_count: z.coerce.number().int().nonnegative(),
})

export type ProjectProgress = {
  readonly projectId: string
  readonly mode: "estimate" | "count"
  readonly total: number
  readonly completed: number
  readonly blocked: number
  readonly percent: number
}

export async function projectProgress(
  sql: QuerySql,
  principal: AuthenticatedPrincipal,
  projectId: string,
): Promise<ProjectProgress> {
  await requireRead(sql, principal, projectId, "project.read")
  const rows = await sql`with included as (
    select pm.work_item_id,state.category,planning.estimate
    from work_item_pm pm
    join workflow_states state on state.id=pm.workflow_state_id
    left join work_item_planning planning on planning.work_item_id=pm.work_item_id
    where pm.workspace_id=${principal.workspaceId} and pm.project_id=${projectId}
      and state.category <> 'canceled'
      and entity_access_allowed(pm.workspace_id,pm.work_item_id,${principal.principalId},'work.read')
      and not exists (select 1 from relations parent
        where parent.from_entity_id=pm.work_item_id and parent.relation_type='parent_of'
          and parent.valid_to is null)
  ) select count(*) item_count,
      count(*) filter (where category='completed') completed_count,
      count(estimate) estimated_count,coalesce(sum(estimate),0) total_estimate,
      coalesce(sum(estimate) filter (where category='completed'),0) completed_estimate,
      count(*) filter (where exists (select 1 from relations blocked
        join work_item_pm blocker on blocker.work_item_id=blocked.from_entity_id
        join workflow_states blocker_state on blocker_state.id=blocker.workflow_state_id
        where blocked.to_entity_id=included.work_item_id and blocked.relation_type='blocks'
          and blocked.valid_to is null and blocker_state.category not in ('completed','canceled')))
        blocked_count from included`
  const row = ProgressRowSchema.parse(rows[0])
  const estimated = row.item_count > 0 && row.estimated_count === row.item_count
  const total = estimated ? row.total_estimate : row.item_count
  const completed = estimated ? row.completed_estimate : row.completed_count
  return {
    projectId,
    mode: estimated ? "estimate" : "count",
    total,
    completed,
    blocked: row.blocked_count,
    percent: total === 0 ? 0 : Math.round((completed / total) * 10_000) / 100,
  }
}

export class PlanningQueries {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  progress(principal: AuthenticatedPrincipal, projectId: string): Promise<ProjectProgress> {
    return projectProgress(this.#sql, principal, projectId)
  }

  async cycles(principal: AuthenticatedPrincipal, spaceId: string): Promise<readonly unknown[]> {
    const spaceRows = await this.#sql<{ readonly id: string }[]>`
      select stable_space_entity_id(${principal.workspaceId},${spaceId}) id`
    await requireRead(this.#sql, principal, required(spaceRows[0]?.id), "space.read")
    return this
      .#sql`select id,space_id "spaceId",sequence::integer sequence,name,start_date::text "startDate",
      end_date::text "endDate",status,goal,capacity_hint "capacityHint",rollover_policy "rolloverPolicy",
      revision::integer revision from cycles where workspace_id=${principal.workspaceId} and space_id=${spaceId}
      order by sequence`
  }

  async milestones(
    principal: AuthenticatedPrincipal,
    projectId: string,
  ): Promise<readonly unknown[]> {
    await requireRead(this.#sql, principal, projectId, "project.read")
    return this.#sql`select milestone.id,milestone.position,milestone.name,milestone.description,
      milestone.target_date::text "targetDate",milestone.revision
      from milestones milestone where milestone.workspace_id=${principal.workspaceId}
        and milestone.project_id=${projectId} order by milestone.position,milestone.id`
  }

  async modules(principal: AuthenticatedPrincipal, projectId: string): Promise<readonly unknown[]> {
    await requireRead(this.#sql, principal, projectId, "project.read")
    return this.#sql`select id,name,description,owner_id "ownerId",start_date::text "startDate",
      target_date::text "targetDate",status,revision from modules
      where workspace_id=${principal.workspaceId} and project_id=${projectId} order by name,id`
  }

  async updates(principal: AuthenticatedPrincipal, projectId: string): Promise<readonly unknown[]> {
    await requireRead(this.#sql, principal, projectId, "project.read")
    return this.#sql`select id,health,body,author_id "authorId",published_at "publishedAt",total,
      completed,estimated,blocked,metric_mode "metricMode",revision from project_updates
      where workspace_id=${principal.workspaceId} and project_id=${projectId}
      order by published_at desc,id`
  }

  async timeline(
    principal: AuthenticatedPrincipal,
    projectId: string,
  ): Promise<readonly unknown[]> {
    await requireRead(this.#sql, principal, projectId, "project.read")
    return this.#sql`select * from (
      select 'project' kind,p.id,p.name,p.start_date::text "startDate",p.target_date::text "targetDate",0 position
        from projects p where p.workspace_id=${principal.workspaceId} and p.id=${projectId}
      union all
      select 'milestone',m.id,m.name,null,m.target_date::text,m.position from milestones m
        where m.workspace_id=${principal.workspaceId} and m.project_id=${projectId}
      union all
      select 'module',m.id,m.name,m.start_date::text,m.target_date::text,0 from modules m
        where m.workspace_id=${principal.workspaceId} and m.project_id=${projectId}
      union all
      select 'work_item',w.id,w.title,pm.start_date::text,pm.due_date::text,0 from work_items w
        join work_item_pm pm on pm.work_item_id=w.id where pm.workspace_id=${principal.workspaceId}
          and pm.project_id=${projectId}
          and entity_access_allowed(pm.workspace_id,pm.work_item_id,${principal.principalId},'work.read')
    ) timeline order by kind,position,id`
  }

  async templates(principal: AuthenticatedPrincipal): Promise<readonly unknown[]> {
    return this.#sql`select id,name,kind,current_revision "currentRevision",scope_space_id "spaceId"
      from planning_templates template where workspace_id=${principal.workspaceId}
        and entity_access_allowed(template.workspace_id,template.id,${principal.principalId},'work.read')
      order by name,id`
  }

  async preferences(principal: AuthenticatedPrincipal): Promise<unknown> {
    const settings = await this.#sql`select id,revision from notification_settings
      where workspace_id=${principal.workspaceId} and principal_id=${principal.principalId}`
    return {
      settings: settings[0] ?? null,
      preferences: await this.#sql`select event_type "eventType",in_app "inApp"
      from notification_preferences where workspace_id=${principal.workspaceId}
        and principal_id=${principal.principalId} order by event_type`,
    }
  }

  async inbox(principal: AuthenticatedPrincipal, after: number, limit: number): Promise<unknown> {
    const rows = await this.#sql`select notification.id,notification.sequence,
      notification.source_event_id "eventId",notification.source_entity_id "entityId",
      notification.payload,notification.created_at "createdAt",notification.read_at "readAt"
      from notifications notification where notification.workspace_id=${principal.workspaceId}
        and notification.recipient_id=${principal.principalId} and notification.sequence>${after}
        and entity_access_allowed(notification.workspace_id,notification.source_entity_id,
          ${principal.principalId},(select read_permission from entity_kind_registry registry
            join entities source on source.kind=registry.kind where source.id=notification.source_entity_id))
      order by notification.sequence limit ${limit + 1}`
    return { notifications: rows.slice(0, limit), hasMore: rows.length > limit }
  }
}

async function requireRead(
  sql: QuerySql,
  principal: AuthenticatedPrincipal,
  entityId: string,
  permission: "project.read" | "space.read",
): Promise<void> {
  const rows =
    await sql`select 1 where entity_access_allowed(${principal.workspaceId},${entityId},${principal.principalId},${permission})`
  if (rows.length !== 1) throw new EntityNotFoundError(entityId)
}
function required(value: string | undefined): string {
  if (value === undefined) throw new EntityNotFoundError("space")
  return value
}
