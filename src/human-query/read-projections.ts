import type { TransactionSql } from "postgres"
import { z } from "zod"
import { ProjectSchema, type Space, SpaceSchema } from "../contracts/r4/index.ts"
import type { FilterNode } from "../contracts/r4/query.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { canReadEntity } from "./read-authorization.ts"
import { UtcDateTimeSchema } from "./utc-datetime.ts"

const SENSITIVE_KEY = /(?:acl|allowance|grant|policy|permission)/i
const ProjectReadSchema = ProjectSchema.extend({
  completedAt: UtcDateTimeSchema.nullable(),
  archivedAt: UtcDateTimeSchema.nullable(),
})

export const HistoryRowSchema = z.strictObject({
  revision: z.number().int().positive(),
  schemaVersion: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
  actor: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
  createdAt: z.string(),
  kind: z.string(),
})

export async function readSpaces(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  id?: string,
): Promise<readonly Space[]> {
  const rows = await transaction`select s.id,e.id "entityId",e.current_revision::integer revision,
    s.name,d.space_key key,d.icon,d.description,s.visibility,
    case when lead.id is null then null else jsonb_build_object('id',lead.id,'name',lead.display_name) end lead
    from spaces s join space_details d on d.workspace_id=s.workspace_id and d.space_id=s.id
    join entities e on e.id=stable_space_entity_id(s.workspace_id,s.id)
    left join principals lead on lead.workspace_id=s.workspace_id and lead.id=d.lead_id
    where s.workspace_id=${principal.workspaceId} and (${id ?? null}::text is null or s.id=${id ?? null})
      and entity_access_allowed(s.workspace_id,e.id,${principal.principalId},'space.read')
    order by d.space_key,s.id`
  return rows.map((row) => SpaceSchema.parse(row))
}

export async function readProject(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  id: string,
): Promise<unknown | undefined> {
  const [row] = await transaction`select p.id,p.workspace_id "workspaceId",p.name,p.slug,p.summary,
    jsonb_build_object('id',o.id,'name',o.display_name) owner,p.lead_ids "leadIds",
    coalesce((select jsonb_agg(ps.space_id order by ps.space_id) from project_spaces ps
      where ps.project_id=p.id and entity_access_allowed(p.workspace_id,
        stable_space_entity_id(p.workspace_id,ps.space_id),${principal.principalId},'space.read')),'[]')
      "participatingSpaceIds",p.state,p.health,p.priority,p.start_date::text "startDate",
    p.target_date::text "targetDate",to_jsonb(p.completed_at)#>>'{}' "completedAt",
    to_jsonb(p.archived_at)#>>'{}' "archivedAt",p.revision::integer
    from projects p join principals o on o.workspace_id=p.workspace_id and o.id=p.owner_id
    where p.workspace_id=${principal.workspaceId} and p.id=${id}
      and entity_access_allowed(p.workspace_id,p.id,${principal.principalId},'project.read')`
  return row === undefined ? undefined : ProjectReadSchema.parse(row)
}

export function readPermissionCase(transaction: TransactionSql, alias: "f" | "t") {
  return alias === "f"
    ? transaction`case when f.kind='project' then 'project.read'
        when f.kind in ('space','workflow','workflow_state','label') then 'space.read'
        when f.kind='saved_view' then 'view.read' else 'work.read' end`
    : transaction`case when t.kind='project' then 'project.read'
        when t.kind in ('space','workflow','workflow_state','label') then 'space.read'
        when t.kind='saved_view' then 'view.read' else 'work.read' end`
}

export async function redactSnapshot(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  row: z.infer<typeof HistoryRowSchema>,
): Promise<Readonly<Record<string, unknown>>> {
  const snapshot = stripSensitiveFields(row.snapshot) as Record<string, unknown>
  const rawProjectId = Reflect.get(snapshot, "project_id")
  const projectId = typeof rawProjectId === "string" ? rawProjectId : null
  if (projectId !== null && !(await canReadEntity(transaction, principal, projectId))) {
    Reflect.deleteProperty(snapshot, "project_id")
  }
  const rawSpaceId = Reflect.get(snapshot, "space_id")
  const spaceId = typeof rawSpaceId === "string" ? rawSpaceId : null
  if (spaceId !== null) {
    const [space] = await transaction<{ readonly id: string }[]>`select stable_space_entity_id(
      ${principal.workspaceId},${spaceId}) id`
    if (space === undefined || !(await canReadEntity(transaction, principal, space.id))) {
      Reflect.deleteProperty(snapshot, "space_id")
    }
  }
  const rawSpaceIds = Reflect.get(snapshot, "participatingSpaceIds")
  const spaceIds = Array.isArray(rawSpaceIds)
    ? rawSpaceIds.filter((value): value is string => typeof value === "string")
    : []
  if (spaceIds.length > 0) {
    const visible = await transaction<{ readonly id: string }[]>`select s.id from spaces s
      where s.workspace_id=${principal.workspaceId} and s.id in ${transaction(spaceIds)}
        and entity_access_allowed(s.workspace_id,stable_space_entity_id(s.workspace_id,s.id),
          ${principal.principalId},'space.read') order by s.id`
    Reflect.set(
      snapshot,
      "participatingSpaceIds",
      visible.map((value) => value.id),
    )
  }
  const rawLabelIds = Reflect.get(snapshot, "labelIds")
  const labelIds = Array.isArray(rawLabelIds)
    ? rawLabelIds.filter((value): value is string => typeof value === "string")
    : []
  if (labelIds.length > 0) {
    const visible = await transaction<{ readonly id: string }[]>`select e.id from entities e
      where e.workspace_id=${principal.workspaceId} and e.kind='label'
        and e.id in ${transaction(labelIds)}
        and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},'space.read')`
    const allowed = new Set(visible.map((value) => value.id))
    Reflect.set(
      snapshot,
      "labelIds",
      labelIds.filter((id) => allowed.has(id)),
    )
  }
  for (const key of [
    "workflow_state_id",
    "thread_id",
    "subject_entity_id",
    "from_entity_id",
    "to_entity_id",
  ]) {
    const id = snapshot[key]
    if (typeof id === "string" && !(await canReadEntity(transaction, principal, id))) {
      Reflect.deleteProperty(snapshot, key)
    }
  }
  return snapshot
}

export async function canReadFilterReferences(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  node: FilterNode | null,
): Promise<boolean> {
  if (node === null) return true
  if (node.op === "and" || node.op === "or") {
    const results = await Promise.all(
      node.filters.map((child) => canReadFilterReferences(transaction, principal, child)),
    )
    return results.every(Boolean)
  }
  if (node.op === "not") return canReadFilterReferences(transaction, principal, node.filter)
  if (node.op === "relation") return canReadEntity(transaction, principal, node.entityId)
  if (node.op !== "eq" && node.op !== "in") return true
  const values = (node.op === "eq" ? [node.value] : node.values).filter(
    (value): value is string => typeof value === "string",
  )
  if (node.field === "spaceId") {
    const rows = await transaction<{ readonly id: string }[]>`select stable_space_entity_id(
      ${principal.workspaceId},value) id from unnest(${transaction.array(values)}) value`
    const results = await Promise.all(
      rows.map((row) => canReadEntity(transaction, principal, row.id)),
    )
    return results.every(Boolean)
  }
  if (["projectId", "workflowStateId", "labelId"].includes(node.field)) {
    const results = await Promise.all(values.map((id) => canReadEntity(transaction, principal, id)))
    return results.every(Boolean)
  }
  return true
}

function stripSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitiveFields)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, child]) => [key, stripSensitiveFields(child)]),
  )
}
