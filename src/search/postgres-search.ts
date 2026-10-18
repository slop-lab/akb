import { randomUUID } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import {
  type SearchPage,
  SearchPageSchema,
  type SearchRequestPaged,
  SearchResultSchema,
} from "../contracts/r4/search.ts"
import { compileBulkAccessCtes } from "../human-query/bulk-access-sql.ts"
import type { CursorBinding } from "../human-query/cursor.ts"
import { QueryBudgetExceededError } from "../human-query/service.ts"
import { allocateQuerySnapshot } from "../human-query/snapshot-allocation.ts"
import { validateStoredSnapshot } from "../human-query/snapshot-validation.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import {
  AuthenticationRequiredError,
  WorkspaceNotFoundError,
} from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import {
  continuationBinding,
  initialBinding,
  nextSearchCursor,
  type SearchAuthority,
  searchQueryHash,
} from "./search-binding.ts"
import type { R4SearchQuery } from "./types.ts"

const MaterializedRowSchema = z.strictObject({
  expires_at: z.string().nullable(),
  matched: z.number().int().nonnegative(),
  persisted: z.boolean(),
})
const PageRowSchema = z.strictObject({
  ordinal: z.number().int().positive(),
  id: z.string(),
  kind: z.enum(["project", "work_item", "comment"]),
  source_revision: z.number().int().positive(),
  title: z.string(),
})

class PostgresR4Search implements R4SearchQuery {
  private readonly sql: Sql
  private readonly signingKey: Uint8Array

  constructor(sql: Sql, signingKey: Uint8Array) {
    if (signingKey.byteLength < 32) throw new RangeError("search signing key requires 32 bytes")
    this.sql = sql
    this.signingKey = signingKey
  }

  async search(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    request: SearchRequestPaged,
  ): Promise<SearchPage> {
    return this.sql.begin(async (transaction) => {
      const authority = await authorize(transaction, principal, workspaceId)
      const queryHash = searchQueryHash(request.text, request.kinds)
      const binding =
        request.cursor === null
          ? await allocateQuerySnapshot(transaction, workspaceId, () =>
              materialize(transaction, principal, request, queryHash, authority.epoch),
            )
          : continuationBinding({
              cursor: request.cursor,
              signingKey: this.signingKey,
              principal,
              queryHash,
              pageSize: request.limit,
              authority,
            })
      const snapshot = await validateStoredSnapshot(transaction, binding)
      const rows = await readPage(transaction, principal, binding, request.limit)
      const results = rows.map((row) =>
        SearchResultSchema.parse({
          id: row.id,
          kind: row.kind,
          title: row.title,
          sourceRevision: row.source_revision,
        }),
      )
      const last = rows.at(-1)
      return SearchPageSchema.parse({
        snapshot: { id: binding.snapshotId, expiresAt: binding.expiresAt },
        results,
        matched: snapshot.matched,
        nextCursor:
          last !== undefined && last.ordinal < snapshot.matched
            ? nextSearchCursor(binding, last.ordinal, this.signingKey)
            : null,
      })
    })
  }
}

export function createPostgresSearch(sql: Sql, signingKey: Uint8Array): R4SearchQuery {
  return new PostgresR4Search(sql, signingKey)
}

async function authorize(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  workspaceId: string,
): Promise<SearchAuthority> {
  if (!(await lockAuthenticatedPrincipal(transaction, principal))) {
    throw new AuthenticationRequiredError()
  }
  if (workspaceId !== principal.workspaceId) throw new WorkspaceNotFoundError()
  const rows = await transaction<{ readonly epoch: number }[]>`
    select epoch::integer from workspace_authority_epochs where workspace_id=${workspaceId} for share`
  const row = rows[0]
  if (row === undefined) throw new WorkspaceNotFoundError()
  return row
}

async function materialize(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  request: SearchRequestPaged,
  queryHash: string,
  epoch: number,
): Promise<CursorBinding> {
  const snapshotId = randomUUID()
  const seedBinding = initialBinding({
    snapshotId,
    principal,
    queryHash,
    pageSize: request.limit,
    epoch,
    expiresAt: "2000-01-01T00:00:00.000Z",
  })
  const rows = await transaction`
    with recursive access_candidates as materialized (
      select d.entity_id,d.kind,d.source_revision,d.document,t.id thread_id,
        t.subject_entity_id,subject.kind subject_kind
      from search_documents d join entities e on e.id=d.entity_id
      left join comments c on d.kind='comment' and c.id=d.entity_id
      left join threads t on c.thread_id=t.id
      left join entities subject on subject.id=t.subject_entity_id
      where d.workspace_id=${principal.workspaceId} and d.kind in ${transaction(request.kinds)}
        and e.lifecycle='active'
    ), access_roots(root_id,entity_id,permission) as (
      select entity_id,entity_id,case when kind='project' then 'project.read' else 'work.read' end
      from access_candidates
      union all select entity_id,thread_id,'work.read' from access_candidates where kind='comment'
      union all select entity_id,subject_entity_id,case when subject_kind='project' then 'project.read'
        when subject_kind='work_item' then 'work.read' else '__unsupported_read_permission__' end
      from access_candidates where kind='comment'
    ), ${compileBulkAccessCtes(transaction, principal.workspaceId, principal.principalId)},
    entity_access_allowed as materialized (
      select candidate.entity_id,candidate.kind,candidate.source_revision,candidate.document
      from access_candidates candidate
      join authorized_access_roots access on access.root_id=candidate.entity_id
    ), matched as materialized (
      select entity_id,kind,source_revision,
        ts_rank_cd(document,websearch_to_tsquery('simple',${request.text})) rank
      from entity_access_allowed
      where document @@ websearch_to_tsquery('simple',${request.text})
    ), candidates as materialized (
      select entity_id,kind,source_revision,
        row_number() over(order by rank desc,entity_id)::integer ordinal
      from matched order by rank desc,entity_id limit 100001
    ), stats as (select count(*)::integer matched from candidates), snapshot as (
      insert into human_query_snapshots
        (id,workspace_id,principal_id,credential_id,query_hash,sort_hash,authority_hash,matched,expires_at)
      select ${snapshotId}::uuid,${principal.workspaceId},${principal.principalId},
        ${principal.credentialId},${queryHash},${seedBinding.sortHash},${seedBinding.authorityHash},
        stats.matched,clock_timestamp()+interval '15 minutes' from stats where stats.matched<=100000
      returning id,matched,expires_at
    ), members as (
      insert into human_query_snapshot_items(snapshot_id,ordinal,entity_id,source_revision,group_key)
      select snapshot.id,c.ordinal,c.entity_id,c.source_revision,c.kind
      from snapshot cross join candidates c returning 1
    )
    select stats.matched,exists(select 1 from snapshot) persisted,
      (select to_char(expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from snapshot)
        expires_at
    from stats`
  const row = MaterializedRowSchema.parse(rows[0])
  if (!row.persisted || row.expires_at === null) throw new QueryBudgetExceededError()
  return initialBinding({
    snapshotId,
    principal,
    queryHash,
    pageSize: request.limit,
    epoch,
    expiresAt: row.expires_at,
  })
}

async function readPage(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  binding: CursorBinding,
  limit: number,
): Promise<readonly z.infer<typeof PageRowSchema>[]> {
  const rows = await transaction`
    with entity_access_allowed as materialized (
      select i.ordinal,i.entity_id id,i.source_revision,i.group_key kind,r.canonical_snapshot
      from human_query_snapshot_items i
      join human_query_snapshots s on s.id=i.snapshot_id
      join entity_revisions r on r.entity_id=i.entity_id and r.revision=i.source_revision
      left join comments c on i.group_key='comment' and c.id=i.entity_id
      left join threads t on c.thread_id=t.id
      left join entities subject on subject.id=t.subject_entity_id
      where i.snapshot_id=${binding.snapshotId}::uuid and i.ordinal>${binding.ordinal}
        and s.expires_at>clock_timestamp() and s.principal_id=${principal.principalId}
        and s.credential_id=${principal.credentialId}
        and entity_access_allowed(s.workspace_id,i.entity_id,${principal.principalId},
          case when i.group_key='project' then 'project.read' else 'work.read' end)
        and (i.group_key<>'comment' or entity_access_allowed(s.workspace_id,t.id,
          ${principal.principalId},'work.read'))
        and (i.group_key<>'comment' or entity_access_allowed(s.workspace_id,t.subject_entity_id,
          ${principal.principalId},case when subject.kind='project' then 'project.read'
            when subject.kind='work_item' then 'work.read'
            else '__unsupported_read_permission__' end))
      order by i.ordinal limit ${limit}
    )
    select ordinal,id,kind,source_revision::integer,
      case kind when 'project' then canonical_snapshot->>'name'
        when 'work_item' then canonical_snapshot->>'title'
        when 'comment' then left(canonical_snapshot->>'body',100) end title
    from entity_access_allowed order by ordinal`
  return rows.map((row) => PageRowSchema.parse(row))
}

export { searchAuthorized } from "./legacy-search.ts"
