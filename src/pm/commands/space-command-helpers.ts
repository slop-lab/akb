import type { TransactionSql } from "postgres"
import { z } from "zod"
import {
  WorkflowStateCreatePayloadSchema,
  WorkflowStateUpdatePayloadSchema,
} from "../../contracts/r4/command-payloads.ts"
import { CommandInvariantError, EntityNotFoundError } from "../../entities/errors.ts"
import type { CommandCall } from "./types.ts"

const ImportWorkflowStateCreatePayloadSchema = WorkflowStateCreatePayloadSchema.extend({
  id: z.string().min(1).max(200),
  active: z.boolean(),
  position: z.number().int().min(0).max(2_147_483_647),
})
const ImportWorkflowStateUpdatePayloadSchema = WorkflowStateUpdatePayloadSchema.extend({
  position: z.number().int().min(0).max(2_147_483_647).optional(),
})

export function parseStateCreate(call: CommandCall) {
  const imported =
    call.route === "import:workflow_state"
      ? ImportWorkflowStateCreatePayloadSchema.parse(call.payload)
      : null
  return {
    active: imported?.active ?? true,
    id: imported?.id ?? null,
    payload: imported ?? WorkflowStateCreatePayloadSchema.parse(call.payload),
  }
}

export function parseStateUpdate(call: CommandCall) {
  return call.route === "import:workflow_state"
    ? ImportWorkflowStateUpdatePayloadSchema.parse(call.payload)
    : WorkflowStateUpdatePayloadSchema.parse(call.payload)
}

export async function requireStateScope(
  transaction: TransactionSql,
  call: CommandCall,
  entityId: string,
): Promise<void> {
  const spaceId = required(call.parentId)
  const rows = await transaction`select 1 from workflow_states where id=${entityId}
    and workspace_id=${call.workspaceId} and space_id=${spaceId}`
  if (rows.length !== 1) throw new EntityNotFoundError(entityId)
}

export async function requireWorkflowCategoryRetention(
  transaction: TransactionSql,
  entityId: string,
): Promise<void> {
  const rows = await transaction`select 1 from workflow_states target
    where target.id=${entityId} and target.active and not exists (
      select 1 from workflow_states candidate
      where candidate.workflow_id=target.workflow_id and candidate.category=target.category
        and candidate.active and candidate.id<>target.id
    )`
  if (rows.length === 1) throw new CommandInvariantError("workflow_requires_category_state")
}

export function mutationInput(
  call: CommandCall,
  permission: "space.manage",
  targetEntityId: string | null,
) {
  return { ...call, permission, targetEntityId }
}

export function required(value: string | null): string {
  if (value === null) throw new CommandInvariantError("resource_id_required")
  return value
}
