import type { Sql, TransactionSql } from "postgres"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import type { CursorBinding } from "./cursor.ts"

export async function readFrozenWorkItem(
  sql: Sql | TransactionSql,
  principal: AuthenticatedPrincipal,
  workspaceId: string,
  id: string,
): Promise<readonly Record<string, unknown>[]> {
  return sql`
    with selected as materialized (
      select e.workspace_id,e.current_revision::integer source_revision,
        r.canonical_snapshot snapshot,r.created_at revision_at
      from entities e join entity_revisions r on r.entity_id=e.id and r.revision=e.current_revision
      where e.workspace_id=${workspaceId} and e.id=${id} and e.kind='work_item'
        and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},'work.read')
    ) select gen_random_uuid()::text snapshot_id,
      to_char(clock_timestamp()+interval '15 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') expires_at,
      1::integer matched,1::integer ordinal,p.source_revision,p.snapshot,
      s.name space_name,sd.space_key,ws.name state_name,ws.category state_category,
      ws.color state_color,ws.position state_position,owner.display_name owner_name,
      project.value project,coalesce(labels.value,'[]'::jsonb) labels,
      parent.id parent_id,null::text group_key
    from selected p
    join spaces s on s.workspace_id=p.workspace_id and s.id=p.snapshot->>'space_id'
    join space_details sd on sd.workspace_id=s.workspace_id and sd.space_id=s.id
    join workflow_states ws on ws.id=p.snapshot->>'workflow_state_id'
    join principals owner on owner.workspace_id=p.workspace_id
      and owner.id=p.snapshot->>'accountable_owner_id'
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
    with authorized_page as materialized (
      select i.ordinal,i.entity_id,i.source_revision,i.group_key,s.id snapshot_id,s.workspace_id,
        s.expires_at,s.matched,r.canonical_snapshot snapshot,r.created_at revision_at
      from human_query_snapshots s join human_query_snapshot_items i on i.snapshot_id=s.id
      join entity_revisions r on r.entity_id=i.entity_id and r.revision=i.source_revision
      where s.id=${binding.snapshotId}::uuid and s.expires_at>clock_timestamp()
        and i.ordinal>${binding.ordinal} and s.principal_id=${principal.principalId}
        and s.credential_id=${principal.credentialId}
        and (${binding.group}::text is null or i.group_key=${binding.group})
        and entity_access_allowed(s.workspace_id,i.entity_id,${principal.principalId},'work.read')
      order by i.ordinal limit ${size}
    ) select p.snapshot_id::text,
      to_char(p.expires_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') expires_at,
      p.matched::integer,p.ordinal,p.source_revision::integer,p.snapshot,
      s.name space_name,sd.space_key,ws.name state_name,ws.category state_category,
      ws.color state_color,ws.position state_position,owner.display_name owner_name,
      project.value project,coalesce(labels.value,'[]'::jsonb) labels,
      parent.id parent_id,p.group_key
    from authorized_page p
    join spaces s on s.workspace_id=${principal.workspaceId} and s.id=p.snapshot->>'space_id'
    join space_details sd on sd.workspace_id=s.workspace_id and sd.space_id=s.id
    join workflow_states ws on ws.id=p.snapshot->>'workflow_state_id'
    join principals owner on owner.workspace_id=${principal.workspaceId}
      and owner.id=p.snapshot->>'accountable_owner_id'
    left join lateral (${projectReferenceSql(transaction, principal.principalId)}) project on true
    left join lateral (${labelReferencesSql(transaction, principal.principalId)}) labels on true
    left join lateral (${parentReferenceSql(transaction, principal.principalId)}) parent on true
    order by p.ordinal`
}

function projectReferenceSql(sql: TransactionSql | Sql, principalId: string) {
  return sql`select jsonb_build_object('id',project_revision.entity_id,
      'name',project_revision.canonical_snapshot->>'name') value
    from entity_revisions project_revision
    where project_revision.entity_id=p.snapshot->>'project_id'
      and project_revision.created_at<=p.revision_at
      and entity_access_allowed(p.workspace_id,project_revision.entity_id,${principalId},'project.read')
    order by project_revision.revision desc limit 1`
}

function labelReferencesSql(sql: TransactionSql | Sql, principalId: string) {
  return sql`select jsonb_agg(jsonb_build_object('id',label_id,
      'name',label_revision.canonical_snapshot->>'name')
      order by label_revision.canonical_snapshot->>'name',label_id) value
    from jsonb_array_elements_text(p.snapshot->'labelIds') label_id
    join lateral (select canonical_snapshot from entity_revisions
      where entity_id=label_id and created_at<=p.revision_at
      order by revision desc limit 1) label_revision on true
    where entity_access_allowed(p.workspace_id,label_id,${principalId},'space.read')`
}

function parentReferenceSql(sql: TransactionSql | Sql, principalId: string) {
  return sql`select relation.from_entity_id id from relations relation
    where relation.to_entity_id=p.snapshot->>'id' and relation.relation_type='parent_of'
      and relation.valid_from<=p.revision_at
      and (relation.valid_to is null or relation.valid_to>p.revision_at)
      and entity_access_allowed(p.workspace_id,relation.id,${principalId},'work.read')
      and entity_access_allowed(p.workspace_id,relation.from_entity_id,${principalId},'work.read')
    order by relation.valid_from desc limit 1`
}
