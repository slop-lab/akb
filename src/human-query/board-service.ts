import { createHash, randomUUID } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { type Board, type BoardRequest, BoardSchema } from "../contracts/r4/human.ts"
import type { FilterNode } from "../contracts/r4/query.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
  WorkspaceNotFoundError,
} from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { type ColumnRow, readColumns } from "./board-columns.ts"
import type {
  BoardBindingOptions,
  BoardPageOptions,
  BoardQueryContext,
  BoardSnapshotRead,
} from "./board-context.ts"
import { type CursorBinding, decodeCursor, encodeCursor } from "./cursor.ts"
import { compileWorkFilter, compileWorkOrder } from "./filter-sql.ts"
import { frozenWorkCard, parseFrozenWorkRow } from "./frozen-work.ts"
import { readFrozenWorkPage } from "./frozen-work-query.ts"
import { QueryBudgetExceededError, SnapshotConflictError } from "./service.ts"
import { allocateQuerySnapshot } from "./snapshot-allocation.ts"
import { validateStoredSnapshot } from "./snapshot-validation.ts"

export class BoardService {
  private readonly sql: Sql
  private readonly signingKey: Uint8Array

  constructor(sql: Sql, signingKey: Uint8Array) {
    if (signingKey.byteLength < 32) throw new RangeError("query signing key requires 32 bytes")
    this.sql = sql
    this.signingKey = signingKey
  }

  async query(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    request: BoardRequest,
  ): Promise<Board> {
    return this.sql.begin(async (transaction) => {
      const epoch = await authorize(transaction, principal, workspaceId)
      const queryHash = digest({
        ...request,
        workflowStateId: null,
        page: { ...request.page, cursor: null },
      })
      const sortHash = digest(request.sort)
      const context = { principal, queryHash, sortHash, epoch }
      const binding =
        request.page.cursor === null
          ? await allocateQuerySnapshot(transaction, workspaceId, () =>
              materialize(transaction, request, context),
            )
          : continueColumn(request, this.signingKey, context)
      if (request.page.cursor !== null) await validateStoredSnapshot(transaction, binding)
      const snapshot = { transaction, principal, binding }
      const columns = await readColumns(
        snapshot,
        request.workflowStateId,
        selectedSpaceIds(request.filter),
      )
      const rendered = await Promise.all(
        columns.map((column) =>
          renderColumn(snapshot, column, { size: request.page.size, signingKey: this.signingKey }),
        ),
      )
      return BoardSchema.parse({
        snapshot: { id: binding.snapshotId, expiresAt: binding.expiresAt },
        columns: rendered,
      })
    })
  }
}

async function authorize(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  workspaceId: string,
): Promise<number> {
  if (!(await lockAuthenticatedPrincipal(transaction, principal)))
    throw new AuthenticationRequiredError()
  if (workspaceId !== principal.workspaceId) throw new WorkspaceNotFoundError()
  const rows = await transaction<{ readonly epoch: number }[]>`select a.epoch::integer epoch
    from workspace_authority_epochs a join membership_permissions p on p.workspace_id=a.workspace_id
      and p.principal_id=${principal.principalId} and p.permission='work.read'
    where a.workspace_id=${workspaceId} for share of a,p`
  const epoch = rows[0]?.epoch
  if (epoch === undefined) throw new PermissionDeniedError()
  return epoch
}

async function materialize(
  transaction: TransactionSql,
  request: BoardRequest,
  context: BoardQueryContext,
): Promise<CursorBinding> {
  const { principal, queryHash, sortHash, epoch } = context
  const snapshotId = randomUUID()
  const expiresAt = new Date(Date.now() + 900_000).toISOString()
  const filter = compileWorkFilter(transaction, request.filter, principal.principalId)
  const order = compileWorkOrder(transaction, request.sort)
  const search = request.search ?? ""
  const rows = await transaction<{ readonly matched: number; readonly persisted: boolean }[]>`
    with authorized as materialized (select e.id from entities e join work_item_pm pm on pm.work_item_id=e.id
      where e.workspace_id=${principal.workspaceId} and e.kind='work_item'
        and (${request.includeArchived} or e.lifecycle='active')
        and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},'work.read')
        and entity_access_allowed(e.workspace_id,pm.workflow_state_id,${principal.principalId},'space.read')
        and entity_access_allowed(e.workspace_id,stable_space_entity_id(e.workspace_id,pm.space_id),
          ${principal.principalId},'space.read')),
    filtered as materialized (select e.id,e.current_revision,pm.workflow_state_id
      from authorized a join entities e on e.id=a.id join work_items w on w.id=e.id
      join work_item_pm pm on pm.work_item_id=e.id join workflow_states ws on ws.id=pm.workflow_state_id
      where ${filter} and (${search}='' or to_tsvector('simple',w.title||' '||pm.description)
        @@ websearch_to_tsquery('simple',${search}))),
    label_sets as materialized (select wl.work_item_id,jsonb_agg(wl.label_id order by wl.label_id) label_ids
      from work_item_labels wl join filtered f on f.id=wl.work_item_id group by wl.work_item_id),
    candidates as materialized (select e.id,e.current_revision,r.schema_version,
      pm.workflow_state_id group_key,pm.sequence,pm.project_id,pm.description,pm.item_type,pm.priority,
      pm.start_date,pm.due_date,pm.completed_at,pm.archived_at,coalesce(labels.label_ids,'[]') label_ids,
      row_number() over(order by ws.position,ws.id,${order})::integer ordinal
      from filtered f join entities e on e.id=f.id join work_items w on w.id=e.id
      join work_item_pm pm on pm.work_item_id=e.id join workflow_states ws on ws.id=pm.workflow_state_id
      join entity_revisions r on r.entity_id=e.id and r.revision=e.current_revision
      left join label_sets labels on labels.work_item_id=e.id
      where r.schema_version in ('work-item.r4.v1','work-item.legacy.v1')
      order by ws.position,ws.id,${order} limit 100001),
    stats as (select count(*)::integer matched from candidates),
    snapshot as (insert into human_query_snapshots
      (id,workspace_id,principal_id,credential_id,query_hash,sort_hash,authority_hash,matched,expires_at)
      select ${snapshotId}::uuid,${principal.workspaceId},${principal.principalId},${principal.credentialId},
        ${queryHash},${sortHash},${digest(epoch)},stats.matched,${expiresAt}::timestamptz from stats
      where stats.matched<=100000 returning id),
    members as (insert into human_query_snapshot_items
      (snapshot_id,ordinal,entity_id,source_revision,group_key,legacy_work_pm_projection)
      select snapshot.id,c.ordinal,c.id,c.current_revision,c.group_key,
        case when c.schema_version='work-item.legacy.v1' then jsonb_build_object(
          '_schema','legacy-work-pm-query.v1','sequence',c.sequence,
          'workflow_state_id',c.group_key,'project_id',c.project_id,
          'description',c.description,'item_type',c.item_type,'priority',c.priority,
          'start_date',c.start_date,'due_date',c.due_date,'completed_at',c.completed_at,
          'archived_at',c.archived_at,'labelIds',c.label_ids) end
      from snapshot cross join candidates c returning 1)
    select stats.matched,exists(select 1 from snapshot) persisted from stats`
  const result = rows[0]
  if (result === undefined || !result.persisted) throw new QueryBudgetExceededError()
  return binding(snapshotId, context, { pageSize: request.page.size, expiresAt, group: null })
}

async function renderColumn(
  snapshot: BoardSnapshotRead,
  column: ColumnRow,
  page: BoardPageOptions,
) {
  const { transaction, principal, binding: bindingValue } = snapshot
  const columnBinding = { ...bindingValue, group: column.id }
  const rows = await readFrozenWorkPage(transaction, principal, columnBinding, page.size)
  const parsed = rows.map(parseFrozenWorkRow)
  const cards = parsed.map(frozenWorkCard)
  const last = parsed.at(-1)
  return {
    state: {
      id: column.id,
      revision: column.revision,
      name: column.name,
      category: column.category,
      color: column.color,
      position: column.position,
      isDefault: column.isDefault,
    },
    total: column.total,
    cards,
    nextCursor:
      last !== undefined && last.ordinal < column.lastOrdinal
        ? encodeCursor({ ...columnBinding, ordinal: last.ordinal }, page.signingKey)
        : null,
  }
}

function continueColumn(
  request: BoardRequest,
  key: Uint8Array,
  context: BoardQueryContext,
): CursorBinding {
  const { principal, queryHash, sortHash, epoch } = context
  const value = decodeCursor(request.page.cursor ?? "", key)
  if (
    value.group !== request.workflowStateId ||
    value.principalId !== principal.principalId ||
    value.credentialId !== principal.credentialId ||
    value.workspaceId !== principal.workspaceId ||
    value.queryHash !== queryHash ||
    value.sortHash !== sortHash ||
    value.pageSize !== request.page.size ||
    value.authorityEpoch !== epoch ||
    value.authorityHash !== digest(epoch)
  ) {
    throw new SnapshotConflictError("snapshot_stale")
  }
  return value
}

function binding(
  snapshotId: string,
  context: BoardQueryContext,
  options: BoardBindingOptions,
): CursorBinding {
  const { principal, queryHash, sortHash, epoch } = context
  return {
    snapshotId,
    ordinal: 0,
    group: options.group,
    principalId: principal.principalId,
    credentialId: principal.credentialId,
    workspaceId: principal.workspaceId,
    queryHash,
    sortHash,
    pageSize: options.pageSize,
    authorityHash: digest(epoch),
    authorityEpoch: epoch,
    expiresAt: options.expiresAt,
  }
}

function selectedSpaceIds(filter: FilterNode | null): readonly string[] {
  if (filter === null) return []
  if (filter.op === "eq" && filter.field === "spaceId" && typeof filter.value === "string")
    return [filter.value]
  if (filter.op === "in" && filter.field === "spaceId")
    return filter.values.filter((value): value is string => typeof value === "string")
  if (filter.op === "and") return [...new Set(filter.filters.flatMap(selectedSpaceIds))]
  return []
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
