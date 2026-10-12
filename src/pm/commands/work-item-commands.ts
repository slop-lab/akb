import { z } from "zod"
import {
  ArchivePayloadSchema,
  WorkItemCreatePayloadSchema,
  WorkItemUpdatePayloadSchema,
} from "../../contracts/r4/command-payloads.ts"
import { CommandInvariantError } from "../../entities/errors.ts"
import type { EntityMutationEngine } from "../../entities/mutation-engine.ts"
import type { MutationResult } from "../../entities/mutation-types.ts"
import { updateWorkItemSearchDocument } from "../projections/search-document.ts"
import { insertEntity, newEntityId, requireDateOrder, requireSpaceAccess } from "./helpers.ts"
import type { CommandCall } from "./types.ts"
import {
  appendLegacyEvent,
  appendLegacyRevision,
  replaceLabels,
  requireAssignmentAccess,
  requireProjectAndLabels,
  requireState,
  validateAssignment,
  workRecord,
  workSnapshot,
} from "./work-item-command-persistence.ts"

export class WorkItemCommandService {
  readonly engine: EntityMutationEngine

  constructor(engine: EntityMutationEngine) {
    this.engine = engine
  }

  execute(call: CommandCall): Promise<MutationResult> {
    switch (call.action) {
      case "work-item.create":
        return this.#create(call)
      case "work-item.update":
        return this.#update(call)
      case "work-item.archive":
        return this.#setArchive(call, true)
      case "work-item.restore":
        return this.#setArchive(call, false)
      default:
        throw new CommandInvariantError("unsupported_work_item_action")
    }
  }

  #create(call: CommandCall): Promise<MutationResult> {
    const payload = WorkItemCreatePayloadSchema.parse(call.payload)
    const entityId = newEntityId("work")
    return this.engine.mutate(
      mutationInput(call, "work.create", null),
      async (transaction, revision) => {
        await requireSpaceAccess(transaction, {
          principal: call.principal,
          spaceId: payload.spaceId,
          permission: "work.create",
        })
        await requireAssignmentAccess(transaction, call, { spaceId: payload.spaceId })
        await insertEntity(transaction, {
          id: entityId,
          workspaceId: call.workspaceId,
          kind: "work_item",
          scopeSpaceId: payload.spaceId,
          actorId: call.principal.principalId,
        })
        await validateAssignment(transaction, call, payload.accountableOwnerId, payload.spaceId)
        const category = await requireState(
          transaction,
          call,
          payload.spaceId,
          payload.workflowStateId,
        )
        await requireProjectAndLabels(
          transaction,
          call,
          payload.spaceId,
          payload.projectId,
          payload.labelIds,
        )
        await transaction`insert into work_items
          (id,workspace_id,space_id,title,state,accountable_owner_id,revision,created_at,updated_at)
          values (${entityId},${call.workspaceId},${payload.spaceId},${payload.title},${category},
            ${payload.accountableOwnerId},${revision},clock_timestamp(),clock_timestamp())`
        await transaction`update work_item_pm set workflow_state_id=${payload.workflowStateId},
          project_id=${payload.projectId},description=${payload.description},item_type=${payload.type},
          priority=${payload.priority},start_date=${payload.startDate},due_date=${payload.dueDate},
          completed_at=${call.restoredAt === undefined ? transaction`case when ${category}='completed' then clock_timestamp() else null end` : transaction`${call.restoredAt}::timestamptz`}
          where work_item_id=${entityId}`
        await replaceLabels(transaction, entityId, payload.labelIds)
        await updateWorkItemSearchDocument(transaction, call.workspaceId, entityId, revision)
        await appendLegacyRevision(transaction, entityId)
        const snapshot = await workSnapshot(transaction, entityId)
        return workRecord(
          entityId,
          revision,
          "entity.created",
          snapshot,
          async (eventId, occurredAt) => {
            await appendLegacyEvent(
              transaction,
              call,
              entityId,
              revision,
              eventId,
              occurredAt,
              null,
            )
          },
        )
      },
    )
  }

  #update(call: CommandCall): Promise<MutationResult> {
    const payload = WorkItemUpdatePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "work.update", entityId),
      async (transaction, revision) => {
        const currentRows =
          await transaction`select w.workspace_id,w.space_id,w.title,w.state,w.accountable_owner_id,
            pm.start_date::text,pm.due_date::text from work_items w join work_item_pm pm
            on pm.work_item_id=w.id where w.id=${entityId} for update of w,pm`
        const current = z
          .strictObject({
            workspace_id: z.string(),
            space_id: z.string(),
            title: z.string(),
            state: z.string(),
            accountable_owner_id: z.string(),
            start_date: z.string().nullable(),
            due_date: z.string().nullable(),
          })
          .parse(currentRows[0])
        requireDateOrder(
          payload.startDate === undefined ? current.start_date : payload.startDate,
          payload.dueDate === undefined ? current.due_date : payload.dueDate,
          "work_item_date_order_invalid",
        )
        const ownerId = payload.accountableOwnerId ?? current.accountable_owner_id
        if (ownerId !== current.accountable_owner_id) {
          await requireAssignmentAccess(transaction, call, {
            spaceId: current.space_id,
            entityId,
          })
          await validateAssignment(transaction, call, ownerId, current.space_id)
        }
        const category =
          payload.workflowStateId === undefined
            ? current.state
            : await requireState(transaction, call, current.space_id, payload.workflowStateId)
        await requireProjectAndLabels(
          transaction,
          call,
          current.space_id,
          payload.projectId,
          payload.labelIds,
        )
        await transaction`update work_items set title=coalesce(${payload.title ?? null},title),
          state=${category},accountable_owner_id=${ownerId},revision=${revision},updated_at=clock_timestamp()
          where id=${entityId}`
        await transaction`update work_item_pm set
          workflow_state_id=coalesce(${payload.workflowStateId ?? null},workflow_state_id),
          project_id=case when ${payload.projectId !== undefined} then ${payload.projectId ?? null} else project_id end,
          description=coalesce(${payload.description ?? null},description),item_type=coalesce(${payload.type ?? null},item_type),
          priority=coalesce(${payload.priority ?? null},priority),
          start_date=case when ${payload.startDate !== undefined} then ${payload.startDate ?? null} else start_date end,
          due_date=case when ${payload.dueDate !== undefined} then ${payload.dueDate ?? null} else due_date end,
          completed_at=case when ${category}='completed' then coalesce(completed_at,clock_timestamp()) else null end
          where work_item_id=${entityId}`
        if (payload.labelIds !== undefined)
          await replaceLabels(transaction, entityId, payload.labelIds)
        await updateWorkItemSearchDocument(transaction, call.workspaceId, entityId, revision)
        await appendLegacyRevision(transaction, entityId)
        const changed = [
          ...(payload.title !== undefined && payload.title !== current.title ? ["title"] : []),
          ...(category !== current.state ? ["state"] : []),
        ]
        const snapshot = await workSnapshot(transaction, entityId)
        return workRecord(
          entityId,
          revision,
          "entity.updated",
          snapshot,
          async (eventId, occurredAt) => {
            await appendLegacyEvent(
              transaction,
              call,
              entityId,
              revision,
              eventId,
              occurredAt,
              changed,
            )
          },
        )
      },
    )
  }

  #setArchive(call: CommandCall, archived: boolean): Promise<MutationResult> {
    ArchivePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "work.update", entityId),
      async (transaction, revision) => {
        await transaction`update work_items set revision=${revision},updated_at=clock_timestamp()
          where id=${entityId}`
        await transaction`update work_item_pm set archived_at=${archived ? (call.restoredAt === undefined ? transaction`clock_timestamp()` : transaction`${call.restoredAt}::timestamptz`) : null}
          where work_item_id=${entityId}`
        await updateWorkItemSearchDocument(transaction, call.workspaceId, entityId, revision)
        await appendLegacyRevision(transaction, entityId)
        const snapshot = await workSnapshot(transaction, entityId)
        return workRecord(
          entityId,
          revision,
          archived ? "entity.archived" : "entity.restored",
          snapshot,
          async (eventId, occurredAt) => {
            await appendLegacyEvent(transaction, call, entityId, revision, eventId, occurredAt, [])
          },
        )
      },
    )
  }
}

function mutationInput(
  call: CommandCall,
  permission: "work.create" | "work.update",
  targetEntityId: string | null,
) {
  return { ...call, permission, targetEntityId }
}

function required(value: string | null): string {
  if (value === null) throw new CommandInvariantError("resource_id_required")
  return value
}
