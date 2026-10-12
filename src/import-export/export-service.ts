import { randomUUID } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { type ExportRequest, type ImportRecord, ImportRecordSchema } from "../contracts/r4/index.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { normalizeExportRecord } from "./export-record-normalizer.ts"
import { normalizeSavedViewDefinition } from "./saved-view-transfer.ts"

const MAX_RECORDS = 100_000
const MAX_BYTES = 100 * 1024 * 1024

export class ExportValidationError extends Error {
  override readonly name = "ExportValidationError"
  readonly code: "not_found" | "budget_exceeded" | "nonportable_graph"

  constructor(code: "not_found" | "budget_exceeded" | "nonportable_graph") {
    super(code)
    this.code = code
  }
}

export async function exportAuthorizedProject(
  sql: Sql,
  principal: AuthenticatedPrincipal,
  request: ExportRequest = { includeArchived: false },
): Promise<string> {
  return sql.begin(async (transaction) => {
    if (!(await lockAuthenticatedPrincipal(transaction, principal))) {
      throw new ExportValidationError("not_found")
    }
    await requireRoot(transaction, principal, request)
    const records = await readRecords(transaction, principal, request)
    const externalIds = new Set<string>()
    for (const record of records) {
      if (externalIds.has(record.externalId)) {
        throw new ExportValidationError("nonportable_graph")
      }
      externalIds.add(record.externalId)
    }
    const scoped = request.projectId !== undefined || request.spaceId !== undefined
    const safeRecords: Exclude<ImportRecord, { readonly kind: "manifest" }>[] = []
    for (const record of records) {
      if (record.kind !== "saved_view") {
        safeRecords.push(record)
        continue
      }
      const normalized = normalizeSavedViewDefinition(record.definition, records)
      if (normalized.kind === "budget_exceeded") throw new ExportValidationError("budget_exceeded")
      if (normalized.kind === "unresolved_reference") {
        throw new ExportValidationError("nonportable_graph")
      }
      if (scoped && normalized.references.length === 0 && !normalized.matchedRange) continue
      safeRecords.push({ ...record, definition: normalized.definition })
    }
    const outputRecords: readonly ImportRecord[] = [
      { kind: "manifest", version: 1, importId: randomUUID(), workspaceId: principal.workspaceId },
      ...safeRecords,
    ]
    if (outputRecords.length > MAX_RECORDS) throw new ExportValidationError("budget_exceeded")
    const output = `${outputRecords.map((record) => JSON.stringify(record)).join("\n")}\n`
    if (Buffer.byteLength(output) > MAX_BYTES) throw new ExportValidationError("budget_exceeded")
    return output
  })
}

async function requireRoot(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  request: ExportRequest,
): Promise<void> {
  if (request.projectId !== undefined) {
    const rows =
      await transaction`select 1 from entities e where e.workspace_id=${principal.workspaceId}
      and e.id=${request.projectId} and e.kind='project'
      and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},'project.read')
      and not exists(select 1 from project_spaces ps where ps.project_id=e.id
        and not entity_access_allowed(e.workspace_id,
          stable_space_entity_id(e.workspace_id,ps.space_id),${principal.principalId},'space.read'))`
    if (rows.length !== 1) throw new ExportValidationError("not_found")
  }
  if (request.spaceId !== undefined) {
    const rows =
      await transaction`select 1 from spaces s where s.workspace_id=${principal.workspaceId}
      and s.id=${request.spaceId} and entity_access_allowed(s.workspace_id,
        stable_space_entity_id(s.workspace_id,s.id),${principal.principalId},'space.read')`
    if (rows.length !== 1) throw new ExportValidationError("not_found")
  }
}

async function readRecords(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  request: ExportRequest,
): Promise<readonly Exclude<ImportRecord, { readonly kind: "manifest" }>[]> {
  const rows = await transaction<{ readonly record: unknown }[]>`
    with authorized as materialized (
      select e.id,e.kind,e.scope_space_id from entities e where e.workspace_id=${principal.workspaceId}
        and (${request.includeArchived} or e.lifecycle='active')
        and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},case
          when e.kind='project' then 'project.read' when e.kind='saved_view' then 'view.read'
          when e.kind in ('space','workflow','workflow_state','label') then 'space.read'
          else 'work.read' end)
    ), selected_projects as materialized (
      select p.id from projects p join authorized a on a.id=p.id
      where (${request.projectId ?? null}::text is null or p.id=${request.projectId ?? null})
        and (${request.spaceId ?? null}::text is null or exists(select 1 from project_spaces ps
          where ps.project_id=p.id and ps.space_id=${request.spaceId ?? null}))
        and not exists(select 1 from project_spaces ps where ps.project_id=p.id
          and not exists(select 1 from authorized sa
            where sa.id=stable_space_entity_id(${principal.workspaceId},ps.space_id)))
    ), selected_work as materialized (
      select pm.work_item_id id,pm.space_id from work_item_pm pm join authorized a on a.id=pm.work_item_id
      join authorized space_access on space_access.id=stable_space_entity_id(${principal.workspaceId},pm.space_id)
      join authorized state_access on state_access.id=pm.workflow_state_id
      where (${request.projectId ?? null}::text is null or pm.project_id=${request.projectId ?? null})
        and (${request.spaceId ?? null}::text is null or pm.space_id=${request.spaceId ?? null})
        and (pm.project_id is null or exists(select 1 from selected_projects p where p.id=pm.project_id))
    ), selected_spaces as materialized (
      select distinct space_id from (
        select space_id from selected_work union all
        select ps.space_id from project_spaces ps join selected_projects p on p.id=ps.project_id union all
        select ${request.spaceId ?? null}::text where ${request.spaceId ?? null}::text is not null union all
        select s.id from spaces s where ${request.projectId ?? null}::text is null
          and ${request.spaceId ?? null}::text is null and s.workspace_id=${principal.workspaceId}
      ) candidate where exists(select 1 from authorized a
        where a.id=stable_space_entity_id(${principal.workspaceId},candidate.space_id))
    ), selected_entities as materialized (
      select id from selected_projects union select id from selected_work
    ), records as (
      select 10 ordering,d.space_key stable,jsonb_build_object('kind','space','externalId',s.id,
        'key',d.space_key,'name',s.name,'visibility',s.visibility,'description',d.description,
        'icon',d.icon,'leadId',d.lead_id) || case when not exists(
          select 1 from workflow_states required where required.workspace_id=s.workspace_id
            and required.space_id=s.id
            and (${request.includeArchived} or required.active)
            and not exists(select 1 from authorized state_access where state_access.id=required.id)
        ) then jsonb_build_object('workflowStateScope',
          case when ${request.includeArchived} then 'all' else 'active' end)
        else '{}'::jsonb end record
      from selected_spaces x join spaces s on s.workspace_id=${principal.workspaceId} and s.id=x.space_id
        join space_details d on d.workspace_id=s.workspace_id and d.space_id=s.id
      union all select 20,ws.id,jsonb_build_object('kind','workflow_state','externalId',ws.id,
        'spaceId',ws.space_id,'name',ws.name,'category',ws.category,'color',ws.color,
        'position',ws.position,'isDefault',ws.is_default,'active',ws.active)
      from workflow_states ws join selected_spaces x on x.space_id=ws.space_id join authorized a on a.id=ws.id
      where ${request.includeArchived} or ws.active
      union all select 30,p.id,jsonb_build_object('kind','project','externalId',p.id,'name',p.name,
        'slug',p.slug,'summary',p.summary,'ownerId',p.owner_id,'leadIds',p.lead_ids,
        'participatingSpaceIds',coalesce((select jsonb_agg(ps.space_id order by ps.space_id)
          from project_spaces ps join authorized sa
            on sa.id=stable_space_entity_id(${principal.workspaceId},ps.space_id)
          where ps.project_id=p.id),'[]'::jsonb),
        'state',p.state,'health',p.health,'priority',p.priority,'startDate',p.start_date,
        'targetDate',p.target_date,'completedAt',p.completed_at,'archivedAt',p.archived_at)
      from projects p join selected_projects x on x.id=p.id
      union all select 40,l.id,jsonb_build_object('kind','label','externalId',l.id,'spaceId',l.space_id,
        'name',l.name,'color',l.color,'archivedAt',l.archived_at)
      from labels l join selected_spaces x on x.space_id=l.space_id join authorized a on a.id=l.id
      where ${request.includeArchived} or l.archived_at is null
      union all select 50,w.id,jsonb_build_object('kind','work_item','externalId',w.id,
        'spaceId',pm.space_id,'title',w.title,'ownerId',w.accountable_owner_id,
        'description',pm.description,'type',pm.item_type,'priority',pm.priority,
        'stateId',pm.workflow_state_id,'projectId',pm.project_id,
        'labelIds',coalesce((select jsonb_agg(wl.label_id order by wl.label_id) from work_item_labels wl
          join authorized la on la.id=wl.label_id where wl.work_item_id=w.id),'[]'),
        'startDate',pm.start_date,'dueDate',pm.due_date,'completedAt',pm.completed_at,'archivedAt',pm.archived_at)
      from selected_work x join work_items w on w.id=x.id join work_item_pm pm on pm.work_item_id=w.id
      union all select 60,r.id,jsonb_build_object('kind','relation','externalId',r.id,'fromId',r.from_entity_id,
        'toId',r.to_entity_id,'relationType',r.relation_type,'archivedAt',r.valid_to)
      from relations r join authorized a on a.id=r.id where exists(select 1 from selected_entities x where x.id=r.from_entity_id)
        and exists(select 1 from selected_entities x where x.id=r.to_entity_id)
        and (${request.includeArchived} or r.valid_to is null)
      union all select 70,c.id,jsonb_build_object('kind','comment','externalId',c.id,
        'subjectId',t.subject_entity_id,'authorId',c.author_id,'body',c.body,'archivedAt',c.archived_at)
      from comments c join threads t on t.id=c.thread_id join authorized a on a.id=c.id
      where exists(select 1 from selected_entities x where x.id=t.subject_entity_id)
        and exists(select 1 from authorized subject where subject.id=t.subject_entity_id)
        and (${request.includeArchived} or c.archived_at is null)
      union all select 80,v.id,jsonb_build_object('kind','saved_view','externalId',v.id,
        'ownerId',v.owner_id,'name',v.name,'access',v.access,'scopeSpaceId',v.scope_space_id,
        'definition',v.definition,'archivedAt',v.archived_at)
      from saved_views v join authorized a on a.id=v.id where (${request.includeArchived} or v.archived_at is null)
        and (v.scope_space_id is null or exists(select 1 from selected_spaces x where x.space_id=v.scope_space_id))
    ) select record from records order by ordering,stable limit ${MAX_RECORDS}`
  return rows.map(({ record }) => {
    const parsed = ImportRecordSchema.parse(normalizeExportRecord(record))
    if (parsed.kind === "manifest") throw new TypeError("export query returned a manifest")
    return parsed
  })
}
