import type { Sql, TransactionSql } from "postgres"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { compileBulkAccessCtes } from "./bulk-access-sql.ts"
import type { CursorBinding } from "./cursor.ts"
import { readPermissionCase } from "./read-projections.ts"

export async function readFrozenWorkItem(
  sql: Sql | TransactionSql,
  principal: AuthenticatedPrincipal,
  workspaceId: string,
  id: string,
): Promise<readonly Record<string, unknown>[]> {
  return sql`
    with selected as materialized (
      select e.workspace_id,e.current_revision::integer source_revision,
        r.schema_version source_schema_version,r.canonical_snapshot snapshot,
        legacy_projection.value legacy_work_pm_projection,
        case when r.schema_version='work-item.legacy.v1' then r.canonical_snapshot->>'spaceId'
          when r.schema_version='work-item.r4.v1' then r.canonical_snapshot->>'space_id' end space_id,
        case when r.schema_version='work-item.legacy.v1' then legacy_projection.value->>'workflow_state_id'
          when r.schema_version='work-item.r4.v1' then r.canonical_snapshot->>'workflow_state_id' end workflow_state_id,
        case when r.schema_version='work-item.legacy.v1' then legacy_projection.value->>'project_id'
          when r.schema_version='work-item.r4.v1' then r.canonical_snapshot->>'project_id' end project_id,
        case when r.schema_version='work-item.legacy.v1' then legacy_projection.value->'labelIds'
          when r.schema_version='work-item.r4.v1' then r.canonical_snapshot->'labelIds' end label_ids,
        r.canonical_snapshot->>'id' work_id,r.created_at revision_at,clock_timestamp() parent_reference_at,
        case when r.schema_version='work-item.legacy.v1' then clock_timestamp()
          else r.created_at end reference_at
      from entities e join entity_revisions r on r.entity_id=e.id and r.revision=e.current_revision
      left join lateral (select jsonb_build_object('_schema','legacy-work-pm-query.v1',
        'sequence',pm.sequence,'workflow_state_id',pm.workflow_state_id,'project_id',pm.project_id,
        'description',pm.description,'item_type',pm.item_type,'priority',pm.priority,
        'start_date',pm.start_date,'due_date',pm.due_date,'completed_at',pm.completed_at,
        'archived_at',pm.archived_at,'labelIds',coalesce((select jsonb_agg(label_id order by label_id)
          from work_item_labels where work_item_id=pm.work_item_id),'[]')) value
        from work_item_pm pm where pm.work_item_id=e.id
          and r.schema_version='work-item.legacy.v1') legacy_projection on true
      where e.workspace_id=${workspaceId} and e.id=${id} and e.kind='work_item'
        and r.schema_version in ('work-item.r4.v1','work-item.legacy.v1')
        and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},'work.read')
        and entity_access_allowed(e.workspace_id,
          stable_space_entity_id(e.workspace_id,case when r.schema_version='work-item.legacy.v1'
            then r.canonical_snapshot->>'spaceId' when r.schema_version='work-item.r4.v1'
            then r.canonical_snapshot->>'space_id' end),
          ${principal.principalId},'space.read')
        and entity_access_allowed(e.workspace_id,case when r.schema_version='work-item.legacy.v1'
          then legacy_projection.value->>'workflow_state_id' when r.schema_version='work-item.r4.v1'
          then r.canonical_snapshot->>'workflow_state_id' end,
          ${principal.principalId},'space.read')
    ) select gen_random_uuid()::text snapshot_id,
      to_char(clock_timestamp()+interval '15 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') expires_at,
      1::integer matched,1::integer ordinal,p.source_revision,p.source_schema_version,p.snapshot,
      p.legacy_work_pm_projection,
      s.name space_name,sd.space_key,ws.name state_name,ws.category state_category,
      ws.color state_color,ws.position state_position,owner.display_name owner_name,
      project.value project,coalesce(labels.value,'[]'::jsonb) labels,
      parent.id parent_id,null::text group_key
    from selected p
    join spaces s on s.workspace_id=p.workspace_id and s.id=p.space_id
    join space_details sd on sd.workspace_id=s.workspace_id and sd.space_id=s.id
    join workflow_states ws on ws.id=p.workflow_state_id
    join principals owner on owner.workspace_id=p.workspace_id
      and owner.id=case when p.source_schema_version='work-item.legacy.v1'
        then p.snapshot->>'accountableOwnerId' else p.snapshot->>'accountable_owner_id' end
    left join lateral (${projectReferenceSql(sql, principal.principalId)}) project on true
    left join lateral (${labelReferencesSql(sql, principal.principalId)}) labels on true
    left join lateral (${parentReferenceSql(sql, principal.principalId)}) parent on true`
}

export async function readFrozenWorkPage(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  binding: CursorBinding,
  size: number,
): Promise<readonly Record<string, unknown>[]> {
  return transaction`
    with recursive page_candidates as materialized (
      select i.ordinal,i.entity_id,i.source_revision,i.group_key,s.id snapshot_id,s.workspace_id,
        s.expires_at,s.matched,r.schema_version source_schema_version,
        r.canonical_snapshot snapshot,i.legacy_work_pm_projection,
        case when r.schema_version='work-item.legacy.v1' then r.canonical_snapshot->>'spaceId'
          when r.schema_version='work-item.r4.v1' then r.canonical_snapshot->>'space_id' end space_id,
        case when r.schema_version='work-item.legacy.v1' then i.legacy_work_pm_projection->>'workflow_state_id'
          when r.schema_version='work-item.r4.v1' then r.canonical_snapshot->>'workflow_state_id' end workflow_state_id,
        case when r.schema_version='work-item.legacy.v1' then i.legacy_work_pm_projection->>'project_id'
          when r.schema_version='work-item.r4.v1' then r.canonical_snapshot->>'project_id' end project_id,
        case when r.schema_version='work-item.legacy.v1' then i.legacy_work_pm_projection->'labelIds'
          when r.schema_version='work-item.r4.v1' then r.canonical_snapshot->'labelIds' end label_ids,
        r.canonical_snapshot->>'id' work_id,r.created_at revision_at,s.created_at parent_reference_at,
        case when r.schema_version='work-item.legacy.v1' then s.created_at
          else r.created_at end reference_at
      from human_query_snapshots s join human_query_snapshot_items i on i.snapshot_id=s.id
      join entity_revisions r on r.entity_id=i.entity_id and r.revision=i.source_revision
      where s.id=${binding.snapshotId}::uuid and s.expires_at>clock_timestamp()
        and r.schema_version in ('work-item.r4.v1','work-item.legacy.v1')
        and i.ordinal>${binding.ordinal} and s.principal_id=${principal.principalId}
        and s.credential_id=${principal.credentialId}
        and (${binding.group}::text is null or i.group_key=${binding.group})
      order by i.ordinal limit ${size}
    ), access_roots(root_id,entity_id,permission) as (
      select entity_id,entity_id,'work.read' from page_candidates
      union all select entity_id,stable_space_entity_id(workspace_id,space_id),'space.read'
        from page_candidates
      union all select entity_id,workflow_state_id,'space.read' from page_candidates
    ), ${compileBulkAccessCtes(transaction, binding.workspaceId, principal.principalId)},
    authorized_page as materialized (
      select candidate.* from page_candidates candidate
      join authorized_access_roots access on access.root_id=candidate.entity_id
    ) select p.snapshot_id::text,
      to_char(p.expires_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') expires_at,
      p.matched::integer,p.ordinal,p.source_revision::integer,p.source_schema_version,p.snapshot,
      p.legacy_work_pm_projection,
      s.name space_name,sd.space_key,ws.name state_name,ws.category state_category,
      ws.color state_color,ws.position state_position,owner.display_name owner_name,
      project.value project,coalesce(labels.value,'[]'::jsonb) labels,
      parent.id parent_id,p.group_key
    from authorized_page p
    join spaces s on s.workspace_id=${principal.workspaceId} and s.id=p.space_id
    join space_details sd on sd.workspace_id=s.workspace_id and sd.space_id=s.id
    join workflow_states ws on ws.id=p.workflow_state_id
    join principals owner on owner.workspace_id=${principal.workspaceId}
      and owner.id=case when p.source_schema_version='work-item.legacy.v1'
        then p.snapshot->>'accountableOwnerId' else p.snapshot->>'accountable_owner_id' end
    left join lateral (${projectReferenceSql(transaction, principal.principalId)}) project on true
    left join lateral (${labelReferencesSql(transaction, principal.principalId)}) labels on true
    left join lateral (${parentReferenceSql(transaction, principal.principalId)}) parent on true
    order by p.ordinal`
}

function projectReferenceSql(sql: TransactionSql | Sql, principalId: string) {
  return sql`select jsonb_build_object('id',project_revision.entity_id,
      'name',project_revision.canonical_snapshot->>'name') value
    from entity_revisions project_revision
    where project_revision.entity_id=p.project_id and project_revision.created_at<=p.reference_at
      and entity_access_allowed(p.workspace_id,project_revision.entity_id,${principalId},'project.read')
    order by project_revision.revision desc limit 1`
}

function labelReferencesSql(sql: TransactionSql | Sql, principalId: string) {
  return sql`select jsonb_agg(jsonb_build_object('id',label_id,
      'name',label_revision.canonical_snapshot->>'name')
      order by label_revision.canonical_snapshot->>'name',label_id) value
    from jsonb_array_elements_text(p.label_ids) label_id
    join lateral (select canonical_snapshot from entity_revisions
      where entity_id=label_id and created_at<=p.reference_at
      order by revision desc limit 1) label_revision on true
    where entity_access_allowed(p.workspace_id,label_id,${principalId},'space.read')`
}

function parentReferenceSql(sql: TransactionSql | Sql, principalId: string) {
  return sql`select relation.from_entity_id id from relations relation
    join entities re on re.workspace_id=relation.workspace_id and re.id=relation.id
    join entities f on f.workspace_id=relation.workspace_id and f.id=relation.from_entity_id
    where relation.to_entity_id=p.work_id and relation.relation_type='parent_of'
      and relation.workspace_id=p.workspace_id and relation.valid_from<=p.parent_reference_at
      and (relation.valid_to is null or relation.valid_to>p.parent_reference_at)
      and (re.archived_at is null or re.archived_at>p.parent_reference_at)
      and entity_access_allowed(p.workspace_id,relation.id,${principalId},
        ${readPermissionCase(sql, "re")})
      and entity_access_allowed(p.workspace_id,relation.from_entity_id,${principalId},
        ${readPermissionCase(sql, "f")})
    order by relation.valid_from desc limit 1`
}
