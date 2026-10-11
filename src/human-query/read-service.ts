import type { Sql } from "postgres"
import {
  BootstrapSchema,
  CommentSchema,
  HistoryEntrySchema,
  RelationSchema,
  SavedViewSchema,
  type Space,
  SpaceConfigSchema,
} from "../contracts/r4/index.ts"
import { PermissionDeniedError, WorkspaceNotFoundError } from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { canReadEntity, hasPermission, lockReadPrincipal } from "./read-authorization.ts"
import {
  canReadFilterReferences,
  HistoryRowSchema,
  readPermissionCase,
  readProject,
  readSpaces,
  redactSnapshot,
} from "./read-projections.ts"

export class HumanReadService {
  private readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  async bootstrap(principal: AuthenticatedPrincipal): Promise<unknown> {
    return this.sql.begin("isolation level read committed", async (transaction) => {
      await lockReadPrincipal(transaction, principal)
      const [workspace] =
        await transaction`select id,name from workspaces where id=${principal.workspaceId}`
      const [actor] = await transaction<
        { readonly id: string; readonly name: string; readonly kind: string }[]
      >`select id,display_name name,kind from principals
        where workspace_id=${principal.workspaceId} and id=${principal.principalId}`
      if (actor?.kind !== "human") throw new PermissionDeniedError()
      const permissions = await transaction<{ readonly permission: string }[]>`
        select permission from membership_permissions where workspace_id=${principal.workspaceId}
          and principal_id=${principal.principalId} order by permission`
      const spaces = await readSpaces(transaction, principal)
      return BootstrapSchema.parse({
        workspace,
        principal: actor,
        permissions: permissions.map((row) => row.permission),
        principals: [{ id: actor.id, name: actor.name }],
        spaces,
        currentSpaceId: spaces[0]?.id ?? null,
      })
    })
  }

  async spaces(principal: AuthenticatedPrincipal): Promise<readonly Space[]> {
    return this.sql.begin("isolation level read committed", async (transaction) => {
      await lockReadPrincipal(transaction, principal)
      return readSpaces(transaction, principal)
    })
  }

  async releaseSnapshot(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    snapshotId: string,
  ): Promise<void> {
    await this.sql.begin("isolation level read committed", async (transaction) => {
      await lockReadPrincipal(transaction, principal)
      if (workspaceId !== principal.workspaceId) throw new WorkspaceNotFoundError()
      await transaction`delete from human_query_snapshots
        where id=${snapshotId}::uuid and workspace_id=${workspaceId}
          and principal_id=${principal.principalId} and credential_id=${principal.credentialId}`
    })
  }

  async spaceConfig(
    principal: AuthenticatedPrincipal,
    spaceId: string,
  ): Promise<unknown | undefined> {
    return this.sql.begin("isolation level read committed", async (transaction) => {
      await lockReadPrincipal(transaction, principal)
      const space = (await readSpaces(transaction, principal, spaceId))[0]
      if (space === undefined) return undefined
      const workflows = await transaction<
        { readonly id: string; readonly name: string; readonly revision: number }[]
      >`select w.id,w.name,w.revision::integer from workflows w join entities e on e.id=w.id
        where w.workspace_id=${principal.workspaceId} and w.space_id=${spaceId} and w.active
          and entity_access_allowed(w.workspace_id,w.id,${principal.principalId},'space.read')`
      const workflow = workflows[0]
      if (workflow === undefined) return undefined
      const states = await transaction`select ws.id,e.current_revision::integer revision,ws.name,
        ws.category,ws.color,ws.position,ws.is_default "isDefault" from workflow_states ws
        join entities e on e.id=ws.id and e.workspace_id=ws.workspace_id
        where ws.workflow_id=${workflow.id} and ws.active
          and entity_access_allowed(ws.workspace_id,ws.id,${principal.principalId},'space.read')
        order by ws.position,ws.id`
      const labels =
        await transaction`select l.id,e.current_revision::integer revision,l.name,l.color
        from labels l join entities e on e.id=l.id and e.workspace_id=l.workspace_id
        where l.workspace_id=${principal.workspaceId} and l.space_id=${spaceId}
          and l.archived_at is null
          and entity_access_allowed(l.workspace_id,l.id,${principal.principalId},'space.read')
        order by l.name,l.id`
      return SpaceConfigSchema.parse({ space, workflow: { ...workflow, states }, labels })
    })
  }

  async project(principal: AuthenticatedPrincipal, id: string): Promise<unknown | undefined> {
    return this.sql.begin("isolation level read committed", async (transaction) => {
      await lockReadPrincipal(transaction, principal)
      return readProject(transaction, principal, id)
    })
  }

  async projects(principal: AuthenticatedPrincipal): Promise<readonly unknown[]> {
    return this.sql
      .begin("isolation level read committed", async (transaction) => {
        await lockReadPrincipal(transaction, principal)
        const rows = await transaction<{ readonly id: string }[]>`select id from projects p
        where workspace_id=${principal.workspaceId}
          and entity_access_allowed(p.workspace_id,p.id,${principal.principalId},'project.read')
        order by created_at,id limit 100`
        return Promise.all(rows.map((row) => readProject(transaction, principal, row.id)))
      })
      .then((items) => items.filter((item) => item !== undefined))
  }

  async history(
    principal: AuthenticatedPrincipal,
    id: string,
  ): Promise<readonly unknown[] | undefined> {
    return this.sql.begin("isolation level read committed", async (transaction) => {
      await lockReadPrincipal(transaction, principal)
      if (!(await canReadEntity(transaction, principal, id))) return undefined
      if (!(await hasPermission(transaction, principal, "history.read"))) return undefined
      const rows = await transaction`select r.revision::integer,r.schema_version "schemaVersion",
        r.canonical_snapshot snapshot,e.kind,
        case when p.id is null then null else jsonb_build_object('id',p.id,'name',p.display_name) end actor,
        to_char(r.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "createdAt"
        from entity_revisions r join entities e on e.id=r.entity_id
        left join principals p on p.workspace_id=e.workspace_id and p.id=r.actor_id
        where e.workspace_id=${principal.workspaceId} and e.id=${id}
          and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},'history.read')
        order by r.revision desc limit 100`
      const projected = await Promise.all(
        rows.map(async (value) => {
          const row = HistoryRowSchema.parse(value)
          return HistoryEntrySchema.parse({
            revision: row.revision,
            schemaVersion: row.schemaVersion,
            actor: row.actor,
            createdAt: row.createdAt,
            snapshot: await redactSnapshot(transaction, principal, row),
          })
        }),
      )
      return projected
    })
  }

  async relations(
    principal: AuthenticatedPrincipal,
    id: string,
  ): Promise<readonly unknown[] | undefined> {
    return this.sql.begin("isolation level read committed", async (transaction) => {
      await lockReadPrincipal(transaction, principal)
      if (!(await canReadEntity(transaction, principal, id))) return undefined
      const rows = await transaction`select r.id,r.relation_type "relationType",
        jsonb_build_object('id',f.id,'name',coalesce(fp.name,fw.title,f.id)) "from",
        jsonb_build_object('id',t.id,'name',coalesce(tp.name,tw.title,t.id)) "to",r.revision::integer,
        to_char(r.valid_from,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "validFrom",
        to_char(r.valid_to,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "validTo"
        from relations r join entities re on re.id=r.id join entities f on f.id=r.from_entity_id
        join entities t on t.id=r.to_entity_id left join projects fp on fp.id=f.id
        left join work_items fw on fw.id=f.id left join projects tp on tp.id=t.id
        left join work_items tw on tw.id=t.id where r.workspace_id=${principal.workspaceId}
          and (${id}=r.from_entity_id or ${id}=r.to_entity_id)
          and entity_access_allowed(r.workspace_id,r.id,${principal.principalId},'work.read')
          and entity_access_allowed(r.workspace_id,f.id,${principal.principalId},${readPermissionCase(transaction, "f")})
          and entity_access_allowed(r.workspace_id,t.id,${principal.principalId},${readPermissionCase(transaction, "t")})
        order by r.valid_from,r.id`
      return rows.map((row) => RelationSchema.parse(row))
    })
  }

  async comments(
    principal: AuthenticatedPrincipal,
    id: string,
  ): Promise<readonly unknown[] | undefined> {
    return this.sql.begin("isolation level read committed", async (transaction) => {
      await lockReadPrincipal(transaction, principal)
      if (!(await canReadEntity(transaction, principal, id))) return undefined
      const rows = await transaction`select c.id,t.subject_entity_id "subjectId",
        jsonb_build_object('id',p.id,'name',p.display_name) author,c.body,c.revision::integer,
        to_char(c.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "createdAt",
        to_char(c.updated_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "updatedAt",
        to_char(c.archived_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "archivedAt"
        from threads t join comments c on c.thread_id=t.id
        join principals p on p.workspace_id=c.workspace_id and p.id=c.author_id
        where t.workspace_id=${principal.workspaceId} and t.subject_entity_id=${id}
          and entity_access_allowed(t.workspace_id,t.id,${principal.principalId},'work.read')
          and entity_access_allowed(c.workspace_id,c.id,${principal.principalId},'work.read')
        order by c.created_at,c.id`
      return rows.map((row) => CommentSchema.parse(row))
    })
  }

  async savedViews(principal: AuthenticatedPrincipal): Promise<readonly unknown[]> {
    return this.sql.begin("isolation level read committed", async (transaction) => {
      await lockReadPrincipal(transaction, principal)
      const rows =
        await transaction`select v.id,jsonb_build_object('id',p.id,'name',p.display_name) owner,
        v.name,v.access,v.scope_space_id "scopeSpaceId",v.definition,v.revision::integer,
        to_char(v.archived_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') "archivedAt"
        from saved_views v join principals p on p.workspace_id=v.workspace_id and p.id=v.owner_id
        where v.workspace_id=${principal.workspaceId}
          and entity_access_allowed(v.workspace_id,v.id,${principal.principalId},'view.read')
          and (v.scope_space_id is null or entity_access_allowed(v.workspace_id,
            stable_space_entity_id(v.workspace_id,v.scope_space_id),${principal.principalId},'space.read'))
        order by v.name,v.id`
      const views = rows.map((row) => SavedViewSchema.parse(row))
      const visible = await Promise.all(
        views.map(async (view) => ({
          view,
          allowed: await canReadFilterReferences(transaction, principal, view.definition.filter),
        })),
      )
      return visible.filter((item) => item.allowed).map((item) => item.view)
    })
  }
}
