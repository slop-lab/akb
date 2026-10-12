import type { TransactionSql } from "postgres"
import type { FILTER_FIELDS, FilterNode, Sort } from "../contracts/r4/query.ts"

function emptyFragment(sql: TransactionSql) {
  return sql``
}

type Fragment = ReturnType<typeof emptyFragment>
type FilterField = (typeof FILTER_FIELDS)[number]

export function compileProjectFilter(
  sql: TransactionSql,
  node: FilterNode | null,
  principalId: string,
): Fragment {
  if (node === null) return sql`true`
  switch (node.op) {
    case "and":
      return sql`(${node.filters.map((child, index) => sql`${index === 0 ? sql`` : sql`and`} ${compileProjectFilter(sql, child, principalId)}`)})`
    case "or":
      return sql`(${node.filters.map((child, index) => sql`${index === 0 ? sql`` : sql`or`} ${compileProjectFilter(sql, child, principalId)}`)})`
    case "not":
      return sql`not (${compileProjectFilter(sql, node.filter, principalId)})`
    case "eq":
      if (node.field === "spaceId") {
        return sql`exists(select 1 from project_spaces ps where ps.project_id=p.id
          and ps.space_id=${node.value}
          and entity_access_allowed(ps.workspace_id,
            stable_space_entity_id(ps.workspace_id,ps.space_id),${principalId},'space.read'))`
      }
      return sql`${field(sql, node.field)} = ${node.value}`
    case "in":
      if (node.field === "spaceId") {
        return sql`exists(select 1 from project_spaces ps where ps.project_id=p.id
          and ps.space_id in ${sql([...node.values])}
          and entity_access_allowed(ps.workspace_id,
            stable_space_entity_id(ps.workspace_id,ps.space_id),${principalId},'space.read'))`
      }
      return sql`${field(sql, node.field)} in ${sql([...node.values])}`
    case "range":
      if (node.field === "spaceId") {
        return sql`exists(select 1 from project_spaces ps where ps.project_id=p.id
          and entity_access_allowed(ps.workspace_id,
            stable_space_entity_id(ps.workspace_id,ps.space_id),${principalId},'space.read')
          and (${node.from === null ? sql`true` : sql`ps.space_id >= ${node.from}`})
          and (${node.to === null ? sql`true` : sql`ps.space_id <= ${node.to}`}))`
      }
      return sql`(${node.from === null ? sql`true` : sql`${field(sql, node.field)} >= ${node.from}`}
        and ${node.to === null ? sql`true` : sql`${field(sql, node.field)} <= ${node.to}`})`
    case "is_null":
      if (node.field === "spaceId") {
        const readableSpace = sql`exists(select 1 from project_spaces ps where ps.project_id=p.id
          and entity_access_allowed(ps.workspace_id,
            stable_space_entity_id(ps.workspace_id,ps.space_id),${principalId},'space.read'))`
        return node.value ? sql`not (${readableSpace})` : readableSpace
      }
      return node.value
        ? sql`${field(sql, node.field)} is null`
        : sql`${field(sql, node.field)} is not null`
    case "relation":
      return sql`exists (select 1 from relations r join entities rf on rf.id=r.from_entity_id
        join entities rt on rt.id=r.to_entity_id where r.workspace_id=e.workspace_id
        and r.relation_type=${node.relationType} and r.valid_to is null
        and ((r.from_entity_id=e.id and r.to_entity_id=${node.entityId}) or
          (r.to_entity_id=e.id and r.from_entity_id=${node.entityId}))
        and entity_access_allowed(r.workspace_id,r.id,${principalId},'work.read')
        and entity_access_allowed(r.workspace_id,rf.id,${principalId},case
          when rf.kind='project' then 'project.read'
          when rf.kind in ('space','workflow','workflow_state','label') then 'space.read'
          when rf.kind='saved_view' then 'view.read' else 'work.read' end)
        and entity_access_allowed(r.workspace_id,rt.id,${principalId},case
          when rt.kind='project' then 'project.read'
          when rt.kind in ('space','workflow','workflow_state','label') then 'space.read'
          when rt.kind='saved_view' then 'view.read' else 'work.read' end))`
    default:
      return assertNever(node)
  }
}

export function compileProjectOrder(sql: TransactionSql, sorts: readonly Sort[]): Fragment {
  const clauses = sorts.map(
    (sort) =>
      sql`${sortField(sql, sort.field)} ${sort.direction === "asc" ? sql`asc nulls last` : sql`desc nulls last`}`,
  )
  return sql`${clauses.map((clause, index) => sql`${index === 0 ? sql`` : sql`,`} ${clause}`)}, e.id asc`
}

function field(sql: TransactionSql, name: FilterField): Fragment {
  switch (name) {
    case "spaceId":
      return sql`(select min(space_id) from project_spaces where project_id=p.id)`
    case "projectId":
      return sql`p.id`
    case "workflowStateId":
    case "stateCategory":
      return sql`p.state`
    case "priority":
      return sql`p.priority`
    case "accountableOwnerId":
      return sql`p.owner_id`
    case "startDate":
      return sql`p.start_date`
    case "dueDate":
      return sql`p.target_date`
    case "createdAt":
      return sql`p.created_at`
    case "updatedAt":
      return sql`p.updated_at`
    case "archived":
      return sql`(p.archived_at is not null)`
    case "type":
    case "labelId":
      return sql`null`
    default:
      return assertNever(name)
  }
}

function sortField(sql: TransactionSql, name: Sort["field"]): Fragment {
  switch (name) {
    case "createdAt":
      return sql`p.created_at`
    case "updatedAt":
      return sql`p.updated_at`
    case "title":
      return sql`lower(p.name)`
    case "priority":
      return sql`array_position(array['none','low','medium','high','urgent'],p.priority)`
    case "dueDate":
      return sql`p.target_date`
    case "workflowPosition":
      return sql`array_position(array['planned','active','paused','completed','canceled'],p.state)`
    default:
      return assertNever(name)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported project query variant: ${String(value)}`)
}
