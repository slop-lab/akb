import type { TransactionSql } from "postgres"
import { z } from "zod"
import { CommandInvariantError } from "../../entities/errors.ts"
import type { JsonObject, MutationRecord } from "../../entities/mutation-types.ts"
import { requireActiveHuman, requireSpaceAccess } from "./helpers.ts"
import type { CommandCall } from "./types.ts"

const SnapshotRowSchema = z.strictObject({ snapshot: z.record(z.string(), z.unknown()) })

export function projectRecord(
  kind: string,
  entityId: string,
  revision: number,
  eventType: MutationRecord["eventType"],
  snapshot: JsonObject,
): MutationRecord {
  return {
    entityId,
    kind,
    revision,
    schemaVersion: `${kind}.r4.v1`,
    eventType,
    snapshot,
    eventData: { id: entityId },
    result: { id: entityId },
  }
}

export async function requireProjectOwner(
  transaction: TransactionSql,
  workspaceId: string,
  principalId: string,
): Promise<void> {
  await requireActiveHuman(transaction, workspaceId, principalId)
}

export async function replaceProjectSpaces(
  transaction: TransactionSql,
  call: CommandCall,
  projectId: string,
  spaces: readonly string[],
): Promise<void> {
  const uniqueSpaces = [...new Set(spaces)]
  const rows = await transaction<{ readonly count: number }[]>`select count(*)::integer count
    from spaces s join entities e on e.workspace_id=s.workspace_id and e.scope_space_id=s.id
      and e.kind='space' and e.lifecycle='active'
    where s.workspace_id=${call.workspaceId} and s.id=any(${transaction.array(uniqueSpaces)})`
  if ((rows[0]?.count ?? 0) !== uniqueSpaces.length) {
    throw new CommandInvariantError("project_spaces_must_be_active")
  }
  for (const spaceId of uniqueSpaces) {
    await requireSpaceAccess(transaction, {
      principal: call.principal,
      spaceId,
      permission: "space.read",
    })
  }
  await transaction`delete from project_spaces where project_id=${projectId}`
  for (const spaceId of uniqueSpaces) {
    await transaction`insert into project_spaces values (${projectId},${call.workspaceId},${spaceId})`
  }
}

export async function labelSnapshot(transaction: TransactionSql, id: string): Promise<JsonObject> {
  const rows = await transaction`select to_jsonb(l) snapshot from labels l where id=${id}`
  return SnapshotRowSchema.parse(rows[0]).snapshot
}

export async function projectSnapshot(
  transaction: TransactionSql,
  id: string,
): Promise<JsonObject> {
  const rows = await transaction`select to_jsonb(p) || jsonb_build_object('participatingSpaceIds',
    coalesce((select jsonb_agg(space_id order by space_id) from project_spaces where project_id=p.id),'[]')) snapshot
    from projects p where id=${id}`
  return SnapshotRowSchema.parse(rows[0]).snapshot
}
