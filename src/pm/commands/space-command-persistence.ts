import type { TransactionSql } from "postgres"
import { z } from "zod"
import type { JsonObject, MutationRecord } from "../../entities/mutation-types.ts"

const SnapshotRowSchema = z.strictObject({ snapshot: z.record(z.string(), z.unknown()) })

export function spaceRecord(
  entityId: string,
  revision: number,
  eventType: MutationRecord["eventType"],
  snapshot: JsonObject,
  result: JsonObject,
): MutationRecord {
  const prefix = entityId.split(":", 1)[0] ?? "entity"
  const kind = prefix === "state" ? "workflow_state" : prefix
  return {
    entityId,
    kind,
    revision,
    schemaVersion: `${kind}.r4.v1`,
    eventType,
    snapshot,
    eventData: result,
    result,
  }
}

export async function spaceSnapshot(
  transaction: TransactionSql,
  workspaceId: string,
  spaceId: string,
): Promise<JsonObject> {
  const rows = await transaction`select jsonb_build_object('id',s.id,'workspaceId',s.workspace_id,
    'key',d.space_key,'name',s.name,'visibility',s.visibility,'description',d.description,
    'icon',d.icon,'leadId',d.lead_id) snapshot from spaces s join space_details d
    on d.workspace_id=s.workspace_id and d.space_id=s.id where s.workspace_id=${workspaceId} and s.id=${spaceId}`
  return SnapshotRowSchema.parse(rows[0]).snapshot
}

export async function stateSnapshot(
  transaction: TransactionSql,
  entityId: string,
): Promise<JsonObject> {
  const rows =
    await transaction`select to_jsonb(s) snapshot from workflow_states s where id=${entityId}`
  return SnapshotRowSchema.parse(rows[0]).snapshot
}
