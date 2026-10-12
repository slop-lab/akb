import type { TransactionSql } from "postgres"
import type { FILTER_FIELDS, FilterNode, Sort } from "../contracts/r4/query.ts"

function emptyFragment(sql: TransactionSql) {
  return sql``
}

type Fragment = ReturnType<typeof emptyFragment>
type FilterField = (typeof FILTER_FIELDS)[number]

export function compileWorkFilter(
  sql: TransactionSql,
  node: FilterNode | null,
  principalId: string,
): Fragment {
  const filter = compileFilterNode(sql, node, principalId)
  return sql`${workMetadataAllowed(sql, principalId)} and (${filter})`
}

function compileFilterNode(
  sql: TransactionSql,
  node: FilterNode | null,
  principalId: string,
): Fragment {
  if (node === null) return sql`true`
  switch (node.op) {
    case "and":
      return sql`(${node.filters.map((child, index) => sql`${index === 0 ? sql`` : sql`and`} ${compileFilterNode(sql, child, principalId)}`)})`
    case "or":
      return sql`(${node.filters.map((child, index) => sql`${index === 0 ? sql`` : sql`or`} ${compileFilterNode(sql, child, principalId)}`)})`
    case "not":
      return sql`not (${compileFilterNode(sql, node.filter, principalId)})`
    case "eq":
      return (
        referenceFilter(sql, node.field, [node.value], principalId) ??
        sql`${field(sql, node.field)} = ${node.value}`
      )
    case "in":
      return (
        referenceFilter(sql, node.field, node.values, principalId) ??
        sql`${field(sql, node.field)} in ${sql([...node.values])}`
      )
    case "range":
      return (
        referenceRangeFilter(sql, node.field, node.from, node.to, principalId) ??
        rangeFilter(sql, field(sql, node.field), node.from, node.to)
      )
    case "is_null":
      return (
        referenceNullFilter(sql, node.field, node.value, principalId) ??
        (node.value
          ? sql`${field(sql, node.field)} is null`
          : sql`${field(sql, node.field)} is not null`)
      )
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

function referenceFilter(
  sql: TransactionSql,
  name: FilterField,
  values: readonly (string | number | boolean)[],
  principalId: string,
): Fragment | undefined {
  const value = readableReference(sql, name, principalId)
  if (value !== undefined) return sql`${value} in ${sql([...values])}`
  if (name === "labelId") {
    return sql`exists(select 1 from work_item_labels wl where wl.work_item_id=e.id
      and wl.label_id in ${sql([...values])}
      and entity_access_allowed(e.workspace_id,wl.label_id,${principalId},'space.read'))`
  }
  return undefined
}

function referenceNullFilter(
  sql: TransactionSql,
  name: FilterField,
  isNull: boolean,
  principalId: string,
): Fragment | undefined {
  const value = readableReference(sql, name, principalId)
  if (value !== undefined) return isNull ? sql`${value} is null` : sql`${value} is not null`
  if (name === "labelId") {
    const exists = sql`exists(select 1 from work_item_labels wl where wl.work_item_id=e.id
      and entity_access_allowed(e.workspace_id,wl.label_id,${principalId},'space.read'))`
    return isNull ? sql`not (${exists})` : exists
  }
  return undefined
}

function referenceRangeFilter(
  sql: TransactionSql,
  name: FilterField,
  from: string | number | null,
  to: string | number | null,
  principalId: string,
): Fragment | undefined {
  const value = readableReference(sql, name, principalId)
  if (value !== undefined) return rangeFilter(sql, value, from, to)
  if (name === "labelId") {
    return sql`exists(select 1 from work_item_labels wl where wl.work_item_id=e.id
      and entity_access_allowed(e.workspace_id,wl.label_id,${principalId},'space.read')
      and ${rangeFilter(sql, sql`wl.label_id`, from, to)})`
  }
  return undefined
}

function rangeFilter(
  sql: TransactionSql,
  value: Fragment,
  from: string | number | null,
  to: string | number | null,
): Fragment {
  return sql`(${from === null ? sql`true` : sql`${value} >= ${from}`}
    and ${to === null ? sql`true` : sql`${value} <= ${to}`})`
}

function readableReference(
  sql: TransactionSql,
  name: FilterField,
  principalId: string,
): Fragment | undefined {
  if (name === "spaceId") {
    return sql`case when entity_access_allowed(e.workspace_id,
      stable_space_entity_id(e.workspace_id,pm.space_id),${principalId},'space.read')
      then pm.space_id end`
  }
  if (name === "projectId") {
    return sql`case when entity_access_allowed(e.workspace_id,pm.project_id,
      ${principalId},'project.read') then pm.project_id end`
  }
  if (name === "workflowStateId") {
    return sql`case when entity_access_allowed(e.workspace_id,pm.workflow_state_id,
      ${principalId},'space.read') then pm.workflow_state_id end`
  }
  return undefined
}

function workMetadataAllowed(sql: TransactionSql, principalId: string): Fragment {
  return sql`entity_access_allowed(e.workspace_id,
    stable_space_entity_id(e.workspace_id,pm.space_id),${principalId},'space.read')
    and entity_access_allowed(e.workspace_id,pm.workflow_state_id,${principalId},'space.read')`
}

export function compileWorkOrder(sql: TransactionSql, sorts: readonly Sort[]): Fragment {
  const first = sorts[0]
  if (first === undefined) throw new TypeError("at least one sort is required")
  const second = sorts[1]
  const third = sorts[2]
  return sql`${sortClause(sql, first)}${second === undefined ? sql`` : sql`, ${sortClause(sql, second)}`}${third === undefined ? sql`` : sql`, ${sortClause(sql, third)}`}, e.id asc`
}

function field(sql: TransactionSql, name: FilterField): Fragment {
  switch (name) {
    case "spaceId":
      return sql`pm.space_id`
    case "projectId":
      return sql`pm.project_id`
    case "workflowStateId":
      return sql`pm.workflow_state_id`
    case "stateCategory":
      return sql`ws.category`
    case "priority":
      return sql`pm.priority`
    case "accountableOwnerId":
      return sql`w.accountable_owner_id`
    case "type":
      return sql`pm.item_type`
    case "labelId":
      return sql`null`
    case "startDate":
      return sql`pm.start_date`
    case "dueDate":
      return sql`pm.due_date`
    case "createdAt":
      return sql`w.created_at`
    case "updatedAt":
      return sql`w.updated_at`
    case "archived":
      return sql`(e.lifecycle='archived')`
    default:
      return assertNever(name)
  }
}

function sortField(sql: TransactionSql, name: Sort["field"]): Fragment {
  switch (name) {
    case "createdAt":
      return sql`w.created_at`
    case "updatedAt":
      return sql`w.updated_at`
    case "title":
      return sql`lower(w.title)`
    case "priority":
      return sql`array_position(array['none','low','medium','high','urgent'],pm.priority)`
    case "dueDate":
      return sql`pm.due_date`
    case "workflowPosition":
      return sql`ws.position`
    default:
      return assertNever(name)
  }
}

function sortClause(sql: TransactionSql, sort: Sort): Fragment {
  return sql`${sortField(sql, sort.field)} ${sort.direction === "asc" ? sql`asc nulls last` : sql`desc nulls last`}`
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported query variant: ${String(value)}`)
}
