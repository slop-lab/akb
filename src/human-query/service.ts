import { createHash, randomUUID } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import type { HumanWorkQuery, QueryPage, WorkItemDetail } from "../contracts/r4/index.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
  WorkspaceNotFoundError,
} from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { type CursorBinding, decodeCursor, encodeCursor, InvalidCursorError } from "./cursor.ts"
import { compileWorkFilter, compileWorkOrder } from "./filter-sql.ts"
import { frozenWorkCard, parseFrozenWorkRow } from "./frozen-work.ts"
import { readFrozenWorkItem, readFrozenWorkPage } from "./frozen-work-query.ts"
import { allocateQuerySnapshot, QueryBudgetExceededError } from "./snapshot-allocation.ts"
import { SnapshotConflictError, validateStoredSnapshot } from "./snapshot-validation.ts"

export { QueryBudgetExceededError, SnapshotConflictError }

export class HumanQueryService {
  private readonly sql: Sql
  private readonly signingKey: Uint8Array

  constructor(sql: Sql, signingKey: Uint8Array) {
    if (signingKey.byteLength < 32) throw new RangeError("query signing key requires 32 bytes")
    this.sql = sql
    this.signingKey = signingKey
  }

  async queryWorkItems(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    query: HumanWorkQuery,
  ): Promise<QueryPage> {
    if (query.model !== "r4") throw new TypeError("legacy model is not an R4 query")
    return this.sql.begin(async (transaction) => {
      const authorityEpoch = await authorizeQuery(transaction, principal, workspaceId)
      const queryHash = digest({ ...query, page: { ...query.page, cursor: null } })
      const sortHash = digest(query.sort)
      const binding =
        query.page.cursor === null
          ? await allocateQuerySnapshot(transaction, workspaceId, () =>
              materialize(transaction, principal, query, queryHash, sortHash, authorityEpoch),
            )
          : validateContinuation(
              query.page.cursor,
              this.signingKey,
              principal,
              queryHash,
              sortHash,
              query.page.size,
              authorityEpoch,
            )
      if (query.page.cursor !== null) await validateStoredSnapshot(transaction, binding)
      const rows = await readFrozenWorkPage(transaction, principal, binding, query.page.size)
      if (rows.length === 0) return emptyPage(binding)
      const parsed = rows.map(parseFrozenWorkRow)
      const items = parsed.map(frozenWorkCard)
      const last = parsed.at(-1)
      const matched = parsed[0]?.matched ?? 0
      const nextCursor =
        last !== undefined && last.ordinal < matched
          ? encodeCursor({ ...binding, ordinal: last.ordinal }, this.signingKey)
          : null
      return {
        snapshot: { id: binding.snapshotId, expiresAt: binding.expiresAt },
        items,
        completeness: { returned: items.length, matched, truncated: false },
        nextCursor,
      }
    })
  }

  async getWorkItem(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    id: string,
  ): Promise<WorkItemDetail | undefined> {
    return this.sql.begin(async (transaction) => {
      await authorizeQuery(transaction, principal, workspaceId)
      const rows = await readFrozenWorkItem(transaction, principal, workspaceId, id)
      const row = rows[0]
      return row === undefined ? undefined : frozenWorkCard(parseFrozenWorkRow(row))
    })
  }
}

async function authorizeQuery(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  workspaceId: string,
): Promise<number> {
  if (!(await lockAuthenticatedPrincipal(transaction, principal)))
    throw new AuthenticationRequiredError()
  if (workspaceId !== principal.workspaceId) throw new WorkspaceNotFoundError()
  const rows = await transaction<{ readonly epoch: number }[]>`
    select a.epoch::integer as epoch from workspace_authority_epochs a
    join membership_permissions p on p.workspace_id=a.workspace_id
      and p.principal_id=${principal.principalId} and p.permission='work.read'
    where a.workspace_id=${workspaceId} for share of a,p`
  const epoch = rows[0]?.epoch
  if (epoch === undefined) throw new PermissionDeniedError()
  return epoch
}

async function materialize(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  query: HumanWorkQuery,
  queryHash: string,
  sortHash: string,
  authorityEpoch: number,
): Promise<CursorBinding> {
  const snapshotId = randomUUID()
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
  const search = query.search ?? ""
  const filter = compileWorkFilter(transaction, query.filter, principal.principalId)
  const order = compileWorkOrder(transaction, query.sort)
  const rows = await transaction<{ readonly matched: number; readonly persisted: boolean }[]>`
    with authorized as materialized (
      select e.id
      from entities e
      where e.workspace_id=${principal.workspaceId} and e.kind='work_item'
        and (${query.includeArchived} or e.lifecycle='active')
        and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},'work.read')
    ), filtered as materialized (
      select e.id,e.current_revision,pm.workflow_state_id
      from authorized a join entities e on e.id=a.id join work_items w on w.id=e.id
      join work_item_pm pm on pm.work_item_id=e.id join workflow_states ws on ws.id=pm.workflow_state_id
      where ${filter} and (${search}='' or to_tsvector('simple',w.title || ' ' || pm.description)
        @@ websearch_to_tsquery('simple',${search}))
    ), label_sets as materialized (
      select wl.work_item_id,jsonb_agg(wl.label_id order by wl.label_id) label_ids
      from work_item_labels wl join filtered f on f.id=wl.work_item_id group by wl.work_item_id
    ), candidates as materialized (
      select e.id,e.current_revision,r.schema_version,pm.sequence,pm.workflow_state_id,pm.project_id,
        pm.description,pm.item_type,pm.priority,pm.start_date,pm.due_date,pm.completed_at,pm.archived_at,
        coalesce(labels.label_ids,'[]') label_ids,row_number() over(order by ${order})::integer ordinal
      from filtered f join entities e on e.id=f.id join work_items w on w.id=e.id
      join work_item_pm pm on pm.work_item_id=e.id join workflow_states ws on ws.id=pm.workflow_state_id
      join entity_revisions r on r.entity_id=e.id and r.revision=e.current_revision
      left join label_sets labels on labels.work_item_id=e.id
      where r.schema_version in ('work-item.r4.v1','work-item.legacy.v1')
      order by ${order} limit 100001
    ), stats as (select count(*)::integer matched from candidates), snapshot as (
      insert into human_query_snapshots
        (id,workspace_id,principal_id,credential_id,query_hash,sort_hash,authority_hash,matched,expires_at)
      select ${snapshotId}::uuid,${principal.workspaceId},${principal.principalId},${principal.credentialId},
        ${queryHash},${sortHash},${digest(authorityEpoch)},stats.matched,${expiresAt}::timestamptz
      from stats where stats.matched<=100000
      returning id,matched
    ), members as (
      insert into human_query_snapshot_items
        (snapshot_id,ordinal,entity_id,source_revision,legacy_work_pm_projection)
      select snapshot.id,c.ordinal,c.id,c.current_revision,
        case when c.schema_version='work-item.legacy.v1' then jsonb_build_object(
          '_schema','legacy-work-pm-query.v1','sequence',c.sequence,
          'workflow_state_id',c.workflow_state_id,'project_id',c.project_id,
          'description',c.description,'item_type',c.item_type,'priority',c.priority,
          'start_date',c.start_date,'due_date',c.due_date,'completed_at',c.completed_at,
          'archived_at',c.archived_at,'labelIds',c.label_ids) end
      from snapshot cross join candidates c returning 1
    ) select stats.matched,exists(select 1 from snapshot) persisted from stats`
  const result = rows[0]
  if (result === undefined) throw new InvalidCursorError()
  if (!result.persisted) throw new QueryBudgetExceededError()
  return {
    snapshotId,
    ordinal: 0,
    group: null,
    principalId: principal.principalId,
    credentialId: principal.credentialId,
    workspaceId: principal.workspaceId,
    queryHash,
    sortHash,
    pageSize: query.page.size,
    authorityHash: digest(authorityEpoch),
    authorityEpoch,
    expiresAt,
  }
}

function validateContinuation(
  cursor: string,
  signingKey: Uint8Array,
  principal: AuthenticatedPrincipal,
  queryHash: string,
  sortHash: string,
  pageSize: number,
  authorityEpoch: number,
): CursorBinding {
  const binding = decodeCursor(cursor, signingKey)
  if (
    binding.principalId !== principal.principalId ||
    binding.credentialId !== principal.credentialId ||
    binding.workspaceId !== principal.workspaceId ||
    binding.queryHash !== queryHash ||
    binding.sortHash !== sortHash ||
    binding.pageSize !== pageSize ||
    binding.authorityEpoch !== authorityEpoch ||
    binding.authorityHash !== digest(authorityEpoch)
  ) {
    throw new SnapshotConflictError("snapshot_stale")
  }
  return binding
}

function emptyPage(binding: CursorBinding): QueryPage {
  return {
    snapshot: { id: binding.snapshotId, expiresAt: binding.expiresAt },
    items: [],
    completeness: { returned: 0, matched: 0, truncated: false },
    nextCursor: null,
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
