import { createHash } from "node:crypto"
import type { TransactionSql } from "postgres"
import type { EntityMutationEngine } from "../../entities/mutation-engine.ts"
import { spaceRecord, stateSnapshot } from "./space-command-persistence.ts"
import type { CommandCall } from "./types.ts"

type DefaultState = {
  readonly id: string
  readonly revision: number
}

export async function handoverWorkflowDefault(
  engine: EntityMutationEngine,
  transaction: TransactionSql,
  call: CommandCall,
  requestedWorkflowId: string | null,
  nextDefaultId: string,
): Promise<void> {
  const workflowId =
    requestedWorkflowId ??
    (
      await transaction<{ readonly workflow_id: string }[]>`
        select workflow_id from workflow_states where id=${nextDefaultId}`
    )[0]?.workflow_id
  if (workflowId === undefined) return
  await transaction`select id from workflows where id=${workflowId} for update`
  const rows = await transaction<DefaultState[]>`select s.id,e.current_revision::integer revision
    from workflow_states s join entities e on e.id=s.id
    where s.workflow_id=${workflowId} and s.active and s.is_default for update of s,e`
  const former = rows[0]
  if (former === undefined || former.id === nextDefaultId) return
  const suffix = createHash("sha256")
    .update(JSON.stringify([call.commandId, call.idempotencyKey, former.id]))
    .digest("hex")
  await engine.mutateInTransaction(
    transaction,
    {
      ...call,
      action: "workflow-state.update",
      route: "internal.workflow-state.default-handover",
      resourceId: former.id,
      targetEntityId: former.id,
      baseRevision: former.revision,
      commandId: `default-${suffix}`,
      idempotencyKey: `default-${suffix}`,
      payload: { isDefault: false },
      permission: "space.manage",
    },
    async (nestedTransaction, revision) => {
      await nestedTransaction`update workflow_states set is_default=false,revision=${revision}
        where id=${former.id}`
      return spaceRecord(
        former.id,
        revision,
        "entity.updated",
        await stateSnapshot(nestedTransaction, former.id),
        { id: former.id },
      )
    },
  )
}
