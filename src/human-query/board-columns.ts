import { z } from "zod"
import type { BoardSnapshotRead } from "./board-context.ts"

const ColumnRowSchema = z.strictObject({
  id: z.string(),
  revision: z.number().int().positive(),
  name: z.string(),
  category: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]),
  color: z.string(),
  position: z.number().int().nonnegative(),
  isDefault: z.boolean(),
  total: z.number().int().nonnegative(),
  lastOrdinal: z.number().int().nonnegative(),
})
export type ColumnRow = z.infer<typeof ColumnRowSchema>

export async function readColumns(
  snapshot: BoardSnapshotRead,
  selectedStateId: string | null,
  spaceIds: readonly string[],
): Promise<readonly ColumnRow[]> {
  const { transaction, principal, binding: bindingValue } = snapshot
  const rows = await transaction`select ws.id,historical.revision::integer revision,
      historical.snapshot->>'name' name,historical.snapshot->>'category' category,
      historical.snapshot->>'color' color,(historical.snapshot->>'position')::integer position,
      coalesce(historical.snapshot->>'isDefault',historical.snapshot->>'is_default')::boolean "isDefault",
      members.total,members."lastOrdinal"
    from human_query_snapshots query_snapshot
    join workflow_states ws on ws.workspace_id=query_snapshot.workspace_id
    join entities state_entity on state_entity.id=ws.id
    join lateral (select r.revision,r.canonical_snapshot snapshot from entity_revisions r
      where r.entity_id=ws.id and r.created_at<=query_snapshot.created_at
        and r.schema_version in ('workflow-state.r4.v1','workflow_state.r4.v1')
      order by r.revision desc limit 1) historical on true
    join lateral (select count(i.entity_id)::integer total,
      coalesce(max(i.ordinal),0)::integer "lastOrdinal" from human_query_snapshot_items i
      where i.snapshot_id=query_snapshot.id and i.group_key=ws.id) members on true
    where query_snapshot.id=${bindingValue.snapshotId}::uuid
      and coalesce((historical.snapshot->>'active')::boolean,true)
      and (${selectedStateId}::text is null or ws.id=${selectedStateId})
      and (${spaceIds.length}=0 or ws.space_id in ${transaction(spaceIds)})
      and entity_access_allowed(ws.workspace_id,ws.id,${principal.principalId},'space.read')
      and entity_access_allowed(ws.workspace_id,stable_space_entity_id(ws.workspace_id,ws.space_id),
        ${principal.principalId},'space.read')
    order by (historical.snapshot->>'position')::integer,ws.id`
  return rows.map((row) => ColumnRowSchema.parse(row))
}
