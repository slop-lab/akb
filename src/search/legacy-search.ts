import type { Sql } from "postgres"
import { z } from "zod"
import {
  type SearchPage,
  type SearchRequestPaged,
  SearchResultSchema,
} from "../contracts/r4/search.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"

const LegacyRowSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["project", "work_item", "comment"]),
  source_revision: z.number().int().positive(),
  title: z.string(),
})

export async function searchAuthorized(
  sql: Sql,
  principal: AuthenticatedPrincipal,
  input: {
    readonly text: string
    readonly kinds: SearchRequestPaged["kinds"]
    readonly limit: number
  },
): Promise<SearchPage["results"]> {
  const rows = await sql`
    with authorized as materialized (
      select d.entity_id,d.kind,d.source_revision,d.document
      from search_documents d
      left join comments c on d.kind='comment' and c.id=d.entity_id
      left join threads t on c.thread_id=t.id
      where d.workspace_id=${principal.workspaceId} and d.kind in ${sql(input.kinds)}
        and entity_access_allowed(d.workspace_id,d.entity_id,${principal.principalId},
          case when d.kind='project' then 'project.read' else 'work.read' end)
        and (d.kind<>'comment' or entity_access_allowed(d.workspace_id,t.subject_entity_id,
          ${principal.principalId},'work.read'))
    ), matched as (
      select *,ts_rank_cd(document,websearch_to_tsquery('simple',${input.text})) rank
      from authorized where document @@ websearch_to_tsquery('simple',${input.text})
    )
    select m.entity_id id,m.kind,m.source_revision::integer,
      case m.kind when 'project' then p.name when 'work_item' then w.title
        else left(c.body,100) end title
    from matched m left join projects p on m.kind='project' and p.id=m.entity_id
    left join work_items w on m.kind='work_item' and w.id=m.entity_id
    left join comments c on m.kind='comment' and c.id=m.entity_id
    order by m.rank desc,m.entity_id limit ${input.limit}`
  return rows.map((row) => {
    const parsed = LegacyRowSchema.parse(row)
    return SearchResultSchema.parse({
      id: parsed.id,
      kind: parsed.kind,
      title: parsed.title,
      sourceRevision: parsed.source_revision,
    })
  })
}
