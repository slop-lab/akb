import type { TransactionSql } from "postgres"
import {
  ArchivePayloadSchema,
  SpaceAccessPayloadSchema,
  SpaceCreatePayloadSchema,
  SpaceUpdatePayloadSchema,
  WorkflowStateCreatePayloadSchema,
  WorkflowStateUpdatePayloadSchema,
  WorkflowUpdatePayloadSchema,
} from "../../contracts/r4/command-payloads.ts"
import { CommandInvariantError, EntityNotFoundError } from "../../entities/errors.ts"
import type { EntityMutationEngine } from "../../entities/mutation-engine.ts"
import type { MutationResult } from "../../entities/mutation-types.ts"
import {
  insertEntity,
  json,
  newEntityId,
  requireActiveHuman,
  requireSpaceAccess,
  stableEntityId,
} from "./helpers.ts"
import { spaceRecord as record, spaceSnapshot, stateSnapshot } from "./space-command-persistence.ts"
import type { CommandCall } from "./types.ts"

export class SpaceCommandService {
  readonly engine: EntityMutationEngine

  constructor(engine: EntityMutationEngine) {
    this.engine = engine
  }

  execute(call: CommandCall): Promise<MutationResult> {
    switch (call.action) {
      case "space.create":
        return this.#createSpace(call)
      case "space.update":
        return this.#updateSpace(call)
      case "space.access":
        return this.#setSpaceAccess(call)
      case "workflow.update":
        return this.#updateWorkflow(call)
      case "workflow-state.create":
        return this.#createState(call)
      case "workflow-state.update":
        return this.#updateState(call)
      case "workflow-state.archive":
        return this.#archiveState(call)
      default:
        throw new CommandInvariantError("unsupported_space_action")
    }
  }

  #createSpace(call: CommandCall): Promise<MutationResult> {
    const payload = SpaceCreatePayloadSchema.parse(call.payload)
    const entityId = stableEntityId("space", call.workspaceId, payload.id)
    return this.engine.mutate(
      mutationInput(call, "space.manage", null),
      async (transaction, revision) => {
        if (payload.leadId !== null) {
          await requireActiveHuman(transaction, call.workspaceId, payload.leadId)
        }
        await transaction`insert into spaces (workspace_id,id,name,visibility)
          values (${call.workspaceId},${payload.id},${payload.name},${payload.visibility})`
        await insertEntity(transaction, {
          id: entityId,
          workspaceId: call.workspaceId,
          kind: "space",
          scopeSpaceId: payload.id,
          actorId: call.principal.principalId,
        })
        await transaction`select initialize_r4_space(${call.workspaceId},${payload.id},${payload.key},
          ${call.principal.principalId},false)`
        await transaction`update space_details set description=${payload.description},icon=${payload.icon},
          lead_id=${payload.leadId} where workspace_id=${call.workspaceId} and space_id=${payload.id}`
        if (payload.visibility === "private") {
          await transaction`insert into space_permissions
            (workspace_id,space_id,principal_id,permission)
            select workspace_id,${payload.id},principal_id,permission from membership_permissions
            where workspace_id=${call.workspaceId} and principal_id=${call.principal.principalId}`
        }
        return record(entityId, revision, "entity.created", json(payload), {
          id: payload.id,
          entityId,
        })
      },
    )
  }

  #updateSpace(call: CommandCall): Promise<MutationResult> {
    const payload = SpaceUpdatePayloadSchema.parse(call.payload)
    const spaceId = required(call.resourceId)
    const entityId = stableEntityId("space", call.workspaceId, spaceId)
    return this.engine.mutate(
      mutationInput(call, "space.manage", entityId),
      async (transaction, revision) => {
        if (payload.leadId !== undefined && payload.leadId !== null) {
          await requireActiveHuman(transaction, call.workspaceId, payload.leadId)
        }
        await transaction`update spaces set name=coalesce(${payload.name ?? null},name),
          visibility=coalesce(${payload.visibility ?? null},visibility),updated_at=clock_timestamp()
          where workspace_id=${call.workspaceId} and id=${spaceId}`
        await transaction`update space_details set description=coalesce(${payload.description ?? null},description),
          icon=case when ${payload.icon !== undefined} then ${payload.icon ?? null} else icon end,
          lead_id=case when ${payload.leadId !== undefined} then ${payload.leadId ?? null} else lead_id end
          where workspace_id=${call.workspaceId} and space_id=${spaceId}`
        const snapshot = await spaceSnapshot(transaction, call.workspaceId, spaceId)
        return record(entityId, revision, "entity.updated", snapshot, { id: spaceId })
      },
    )
  }

  #setSpaceAccess(call: CommandCall): Promise<MutationResult> {
    const payload = SpaceAccessPayloadSchema.parse(call.payload)
    const spaceId = required(call.resourceId)
    const entityId = stableEntityId("space", call.workspaceId, spaceId)
    return this.engine.mutate(
      mutationInput(call, "space.manage", entityId),
      async (transaction, revision) => {
        await requireActiveHuman(transaction, call.workspaceId, payload.principalId)
        await transaction`delete from space_permissions where workspace_id=${call.workspaceId}
          and space_id=${spaceId} and principal_id=${payload.principalId}`
        await transaction`insert into space_permissions (workspace_id,space_id,principal_id,permission)
          select workspace_id,${spaceId},principal_id,permission from membership_permissions
          where workspace_id=${call.workspaceId} and principal_id=${payload.principalId}
            and permission=any(${transaction.array([...payload.permissions])})`
        const retained = await transaction`select 1 from space_permissions
          where workspace_id=${call.workspaceId} and space_id=${spaceId}
            and principal_id=${call.principal.principalId} and permission='space.manage'`
        if (retained.length !== 1) {
          throw new CommandInvariantError("caller_must_retain_space_manage")
        }
        const snapshot = await spaceSnapshot(transaction, call.workspaceId, spaceId)
        return record(entityId, revision, "acl.changed", snapshot, { id: spaceId })
      },
    )
  }

  #updateWorkflow(call: CommandCall): Promise<MutationResult> {
    const payload = WorkflowUpdatePayloadSchema.parse(call.payload)
    const spaceId = required(call.parentId)
    const entityId = stableEntityId("workflow", call.workspaceId, spaceId)
    return this.engine.mutate(
      mutationInput(call, "space.manage", entityId),
      async (transaction, revision) => {
        await transaction`update workflows set name=${payload.name},revision=${revision}
          where id=${entityId}`
        return record(entityId, revision, "entity.updated", json({ id: entityId, ...payload }), {
          id: entityId,
        })
      },
    )
  }

  #createState(call: CommandCall): Promise<MutationResult> {
    const payload = WorkflowStateCreatePayloadSchema.parse(call.payload)
    const spaceId = required(call.parentId)
    const workflowId = stableEntityId("workflow", call.workspaceId, spaceId)
    const entityId = newEntityId("state")
    return this.engine.mutate(
      mutationInput(call, "space.manage", null),
      async (transaction, revision) => {
        await requireSpaceAccess(transaction, {
          principal: call.principal,
          spaceId,
          permission: "space.manage",
        })
        await transaction`select id from workflows where id=${workflowId} for update`
        const counts = await transaction<{ readonly count: number }[]>`
          select count(*)::integer count from workflow_states
          where workflow_id=${workflowId} and active`
        if ((counts[0]?.count ?? 0) >= 20) {
          throw new CommandInvariantError("workflow_state_limit")
        }
        await insertEntity(transaction, {
          id: entityId,
          workspaceId: call.workspaceId,
          kind: "workflow_state",
          scopeSpaceId: spaceId,
          actorId: call.principal.principalId,
        })
        if (payload.isDefault) {
          await transaction`update workflow_states set is_default=false where workflow_id=${workflowId}`
        }
        await transaction`insert into workflow_states
          (id,workflow_id,workspace_id,space_id,name,category,color,position,is_default,revision)
          values (${entityId},${workflowId},${call.workspaceId},${spaceId},${payload.name},
            ${payload.category},${payload.color},${payload.position},${payload.isDefault},${revision})`
        return record(entityId, revision, "entity.created", json({ id: entityId, ...payload }), {
          id: entityId,
        })
      },
    )
  }

  #updateState(call: CommandCall): Promise<MutationResult> {
    const payload = WorkflowStateUpdatePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "space.manage", entityId),
      async (transaction, revision) => {
        await requireStateScope(transaction, call, entityId)
        if (payload.isDefault === false) {
          const current = await transaction`select 1 from workflow_states where id=${entityId}
            and active and is_default`
          if (current.length === 1)
            throw new CommandInvariantError("workflow_requires_default_state")
        }
        if (payload.isDefault) {
          await transaction`update workflow_states set is_default=false where workflow_id=(
            select workflow_id from workflow_states where id=${entityId})`
        }
        await transaction`update workflow_states set name=coalesce(${payload.name ?? null},name),
          color=coalesce(${payload.color ?? null},color),position=coalesce(${payload.position ?? null},position),
          is_default=coalesce(${payload.isDefault ?? null},is_default),revision=${revision} where id=${entityId}`
        const snapshot = await stateSnapshot(transaction, entityId)
        return record(entityId, revision, "entity.updated", snapshot, { id: entityId })
      },
    )
  }

  #archiveState(call: CommandCall): Promise<MutationResult> {
    ArchivePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "space.manage", entityId),
      async (transaction, revision) => {
        await requireStateScope(transaction, call, entityId)
        const blocked = await transaction`select 1 from workflow_states s where s.id=${entityId}
          and (s.is_default or exists (select 1 from work_item_pm pm where pm.workflow_state_id=s.id))`
        if (blocked.length === 1) throw new CommandInvariantError("workflow_state_in_use")
        await transaction`update workflow_states set active=false,is_default=false,revision=${revision}
          where id=${entityId}`
        const snapshot = await stateSnapshot(transaction, entityId)
        return record(entityId, revision, "entity.archived", snapshot, { id: entityId })
      },
    )
  }
}

async function requireStateScope(
  transaction: TransactionSql,
  call: CommandCall,
  entityId: string,
): Promise<void> {
  const spaceId = required(call.parentId)
  const rows = await transaction`select 1 from workflow_states where id=${entityId}
    and workspace_id=${call.workspaceId} and space_id=${spaceId}`
  if (rows.length !== 1) throw new EntityNotFoundError(entityId)
}

function mutationInput(
  call: CommandCall,
  permission: "space.manage",
  targetEntityId: string | null,
) {
  return { ...call, permission, targetEntityId }
}

function required(value: string | null): string {
  if (value === null) throw new CommandInvariantError("resource_id_required")
  return value
}
