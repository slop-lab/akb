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
  const rows = await transaction`select ws.id,state_entity.current_revision::integer revision,
      ws.name,ws.category,ws.color,ws.position,
      ws.is_default "isDefault",count(i.entity_id)::integer total,
      coalesce(max(i.ordinal),0)::integer "lastOrdinal"
    from workflow_states ws join entities state_entity on state_entity.id=ws.id
    left join human_query_snapshot_items i on i.snapshot_id=${bindingValue.snapshotId}::uuid
      and i.group_key=ws.id
    where ws.workspace_id=${principal.workspaceId} and ws.active
      and (${selectedStateId}::text is null or ws.id=${selectedStateId})
      and (${spaceIds.length}=0 or ws.space_id in ${transaction(spaceIds)})
      and entity_access_allowed(ws.workspace_id,ws.id,${principal.principalId},'space.read')
      and entity_access_allowed(ws.workspace_id,stable_space_entity_id(ws.workspace_id,ws.space_id),
        ${principal.principalId},'space.read')
    group by ws.id,state_entity.current_revision order by ws.position,ws.id`
  return rows.map((row) => ColumnRowSchema.parse(row))
}
