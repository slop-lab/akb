import { createHash, randomUUID } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import type { Project, ProjectPage, ProjectQuery } from "../contracts/r4/index.ts"
import { ProjectSchema } from "../contracts/r4/index.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import {
  AuthenticationRequiredError,
  PermissionDeniedError,
  WorkspaceNotFoundError,
} from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { type CursorBinding, decodeCursor, encodeCursor } from "./cursor.ts"
import { compileProjectFilter, compileProjectOrder } from "./project-filter-sql.ts"
import { QueryBudgetExceededError, SnapshotConflictError } from "./service.ts"
import { allocateQuerySnapshot } from "./snapshot-allocation.ts"
import { validateStoredSnapshot } from "./snapshot-validation.ts"
import { UtcDateTimeSchema } from "./utc-datetime.ts"

const ProjectSnapshotSchema = z.strictObject({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  slug: z.string(),
  summary: z.string(),
  owner_id: z.string(),
  lead_ids: z.array(z.string()).readonly(),
  state: z.enum(["planned", "active", "paused", "completed", "canceled"]),
  health: z.enum(["on_track", "at_risk", "off_track"]),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]),
  start_date: z.string().nullable(),
  target_date: z.string().nullable(),
  completed_at: UtcDateTimeSchema.nullable(),
  archived_at: UtcDateTimeSchema.nullable(),
  revision: z.coerce.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
  participatingSpaceIds: z.array(z.string()).readonly(),
})
const ProjectRowSchema = z.strictObject({
  snapshot_id: z.string().uuid(),
  expires_at: z.string(),
  matched: z.number().int(),
  ordinal: z.number().int(),
  source_revision: z.number().int().positive(),
  snapshot: z.record(z.string(), z.unknown()),
  owner_name: z.string(),
  participating_space_ids: z.array(z.string()).readonly(),
})
type ProjectRow = z.infer<typeof ProjectRowSchema>

export class ProjectQueryService {
  private readonly sql: Sql
  private readonly signingKey: Uint8Array

  constructor(sql: Sql, signingKey: Uint8Array) {
    if (signingKey.byteLength < 32) throw new RangeError("query signing key requires 32 bytes")
    this.sql = sql
    this.signingKey = signingKey
  }

  async queryProjects(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    query: ProjectQuery,
  ): Promise<ProjectPage> {
    return this.sql.begin(async (transaction) => {
      const epoch = await authorize(transaction, principal, workspaceId)
      const queryHash = digest({ ...query, page: { ...query.page, cursor: null } })
      const sortHash = digest(query.sort)
      const binding =
        query.page.cursor === null
          ? await allocateQuerySnapshot(transaction, workspaceId, () =>
              materialize(transaction, principal, query, queryHash, sortHash, epoch),
            )
          : continuation(
              query.page.cursor,
              this.signingKey,
              principal,
              queryHash,
              sortHash,
              query.page.size,
              epoch,
            )
      if (query.page.cursor !== null) await validateStoredSnapshot(transaction, binding)
      const rows = await readPage(transaction, principal, binding, query.page.size)
      const parsed = rows.map((row) => ProjectRowSchema.parse(row))
      const items = parsed.map(projectFromRow)
      const last = parsed.at(-1)
      return {
        snapshot: { id: binding.snapshotId, expiresAt: binding.expiresAt },
        items,
        matched: parsed[0]?.matched ?? 0,
        nextCursor:
          last !== undefined && last.ordinal < (parsed[0]?.matched ?? 0)
            ? encodeCursor({ ...binding, ordinal: last.ordinal }, this.signingKey)
            : null,
      }
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
      and p.principal_id=${principal.principalId} and p.permission='project.read'
    where a.workspace_id=${workspaceId} for share of a,p`
  const epoch = rows[0]?.epoch
  if (epoch === undefined) throw new PermissionDeniedError()
  return epoch
}

async function materialize(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  query: ProjectQuery,
  queryHash: string,
  sortHash: string,
  epoch: number,
): Promise<CursorBinding> {
  const id = randomUUID()
  const expiresAt = new Date(Date.now() + 900_000).toISOString()
  const filter = compileProjectFilter(transaction, query.filter, principal.principalId)
  const order = compileProjectOrder(transaction, query.sort)
  const rows = await transaction<{ readonly matched: number; readonly persisted: boolean }[]>`
    with authorized as materialized (select e.id from entities e
      where e.workspace_id=${principal.workspaceId} and e.kind='project'
        and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},'project.read')),
    candidates as materialized (select e.id,e.current_revision,
      row_number() over(order by ${order})::integer ordinal
      from authorized a join entities e on e.id=a.id join projects p on p.id=e.id
      where (${query.includeArchived} or p.archived_at is null) and ${filter}
        and (${query.search ?? ""}='' or to_tsvector('simple',p.name||' '||p.summary)
          @@ websearch_to_tsquery('simple',${query.search ?? ""})) order by ${order} limit 100001),
    stats as (select count(*)::integer matched from candidates),
    snapshot as (insert into human_query_snapshots
      (id,workspace_id,principal_id,credential_id,query_hash,sort_hash,authority_hash,matched,expires_at)
      select ${id}::uuid,${principal.workspaceId},${principal.principalId},${principal.credentialId},
        ${queryHash},${sortHash},${digest(epoch)},stats.matched,${expiresAt}::timestamptz
      from stats where stats.matched<=100000 returning id),
    members as (insert into human_query_snapshot_items(snapshot_id,ordinal,entity_id,source_revision)
      select snapshot.id,c.ordinal,c.id,c.current_revision from snapshot cross join candidates c returning 1)
    select stats.matched,exists(select 1 from snapshot) persisted from stats`
  if (rows[0]?.persisted !== true) throw new QueryBudgetExceededError()
  return {
    snapshotId: id,
    ordinal: 0,
    group: null,
    principalId: principal.principalId,
    credentialId: principal.credentialId,
    workspaceId: principal.workspaceId,
    queryHash,
    sortHash,
    pageSize: query.page.size,
    authorityHash: digest(epoch),
    authorityEpoch: epoch,
    expiresAt,
  }
}

async function readPage(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  binding: CursorBinding,
  size: number,
): Promise<readonly Record<string, unknown>[]> {
  return transaction`with authorized_page as materialized (select i.ordinal,i.source_revision,
      s.id snapshot_id,s.expires_at,s.matched,r.canonical_snapshot snapshot
      from human_query_snapshots s join human_query_snapshot_items i on i.snapshot_id=s.id
      join entity_revisions r on r.entity_id=i.entity_id and r.revision=i.source_revision
      where s.id=${binding.snapshotId}::uuid and s.expires_at>clock_timestamp()
        and i.ordinal>${binding.ordinal} and s.principal_id=${principal.principalId}
        and s.credential_id=${principal.credentialId}
        and entity_access_allowed(s.workspace_id,i.entity_id,${principal.principalId},'project.read')
      order by i.ordinal limit ${size})
    select p.snapshot_id::text,to_char(p.expires_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') expires_at,
      p.matched::integer,p.ordinal,p.source_revision::integer,p.snapshot,o.display_name owner_name,
      coalesce((select jsonb_agg(space_id order by space_id)
        from jsonb_array_elements_text(p.snapshot->'participatingSpaceIds') space_id
        where entity_access_allowed(${principal.workspaceId},stable_space_entity_id(
          ${principal.workspaceId},space_id),${principal.principalId},'space.read')),'[]')
        participating_space_ids
    from authorized_page p join principals o on o.workspace_id=${principal.workspaceId}
      and o.id=p.snapshot->>'owner_id' order by p.ordinal`
}

function continuation(
  cursor: string,
  key: Uint8Array,
  principal: AuthenticatedPrincipal,
  queryHash: string,
  sortHash: string,
  pageSize: number,
  epoch: number,
): CursorBinding {
  const binding = decodeCursor(cursor, key)
  if (
    binding.principalId !== principal.principalId ||
    binding.credentialId !== principal.credentialId ||
    binding.workspaceId !== principal.workspaceId ||
    binding.queryHash !== queryHash ||
    binding.sortHash !== sortHash ||
    binding.pageSize !== pageSize ||
    binding.authorityEpoch !== epoch ||
    binding.authorityHash !== digest(epoch)
  )
    throw new SnapshotConflictError("snapshot_stale")
  return binding
}

function projectFromRow(row: ProjectRow): Project {
  const value = ProjectSnapshotSchema.parse(row.snapshot)
  return ProjectSchema.parse({
    id: value.id,
    workspaceId: value.workspace_id,
    name: value.name,
    slug: value.slug,
    summary: value.summary,
    owner: { id: value.owner_id, name: row.owner_name },
    leadIds: value.lead_ids,
    participatingSpaceIds: row.participating_space_ids,
    state: value.state,
    health: value.health,
    priority: value.priority,
    startDate: value.start_date,
    targetDate: value.target_date,
    completedAt: value.completed_at,
    archivedAt: value.archived_at,
    revision: row.source_revision,
  })
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
