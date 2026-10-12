import {
  ArchivePayloadSchema,
  LabelCreatePayloadSchema,
  LabelUpdatePayloadSchema,
  ProjectCreatePayloadSchema,
  ProjectUpdatePayloadSchema,
} from "../../contracts/r4/command-payloads.ts"
import { CommandInvariantError } from "../../entities/errors.ts"
import type { EntityMutationEngine } from "../../entities/mutation-engine.ts"
import type { MutationResult } from "../../entities/mutation-types.ts"
import { updateProjectSearchDocument } from "../projections/search-document.ts"
import {
  insertEntity,
  json,
  newEntityId,
  requireActiveHuman,
  requireDateOrder,
  requireSpaceAccess,
} from "./helpers.ts"
import {
  labelSnapshot,
  projectSnapshot,
  projectRecord as record,
  replaceProjectSpaces,
  requireProjectOwner,
} from "./project-command-persistence.ts"
import type { CommandCall } from "./types.ts"

export class ProjectCommandService {
  readonly engine: EntityMutationEngine

  constructor(engine: EntityMutationEngine) {
    this.engine = engine
  }

  execute(call: CommandCall): Promise<MutationResult> {
    switch (call.action) {
      case "label.create":
        return this.#createLabel(call)
      case "label.update":
        return this.#updateLabel(call)
      case "label.archive":
        return this.#archiveLabel(call)
      case "project.create":
        return this.#createProject(call)
      case "project.update":
        return this.#updateProject(call)
      case "project.archive":
        return this.#setProjectArchive(call, true)
      case "project.restore":
        return this.#setProjectArchive(call, false)
      default:
        throw new CommandInvariantError("unsupported_project_action")
    }
  }

  #createLabel(call: CommandCall): Promise<MutationResult> {
    const payload = LabelCreatePayloadSchema.parse(call.payload)
    const spaceId = required(call.parentId)
    const entityId = newEntityId("label")
    return this.engine.mutate(
      mutationInput(call, "space.manage", null),
      async (transaction, revision) => {
        await requireSpaceAccess(transaction, {
          principal: call.principal,
          spaceId,
          permission: "space.manage",
        })
        await insertEntity(transaction, {
          id: entityId,
          workspaceId: call.workspaceId,
          kind: "label",
          scopeSpaceId: spaceId,
          actorId: call.principal.principalId,
        })
        await transaction`insert into labels (id,workspace_id,space_id,name,color,revision)
          values (${entityId},${call.workspaceId},${spaceId},${payload.name},${payload.color},${revision})`
        const snapshot = json({ id: entityId, spaceId, ...payload, archivedAt: null })
        return record("label", entityId, revision, "entity.created", snapshot)
      },
    )
  }

  #updateLabel(call: CommandCall): Promise<MutationResult> {
    const payload = LabelUpdatePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "space.manage", entityId),
      async (transaction, revision) => {
        await transaction`update labels set name=coalesce(${payload.name ?? null},name),
          color=coalesce(${payload.color ?? null},color),revision=${revision} where id=${entityId}`
        return record(
          "label",
          entityId,
          revision,
          "entity.updated",
          await labelSnapshot(transaction, entityId),
        )
      },
    )
  }

  #archiveLabel(call: CommandCall): Promise<MutationResult> {
    ArchivePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "space.manage", entityId),
      async (transaction, revision) => {
        await transaction`update labels set archived_at=${call.restoredAt === undefined ? transaction`clock_timestamp()` : transaction`${call.restoredAt}::timestamptz`},revision=${revision}
          where id=${entityId}`
        return record(
          "label",
          entityId,
          revision,
          "entity.archived",
          await labelSnapshot(transaction, entityId),
        )
      },
    )
  }

  #createProject(call: CommandCall): Promise<MutationResult> {
    const payload = ProjectCreatePayloadSchema.parse(call.payload)
    const entityId = newEntityId("project")
    return this.engine.mutate(
      mutationInput(call, "project.manage", null),
      async (transaction, revision) => {
        await requireProjectOwner(transaction, call.workspaceId, payload.ownerId)
        for (const leadId of new Set(payload.leadIds)) {
          await requireActiveHuman(transaction, call.workspaceId, leadId)
        }
        await insertEntity(transaction, {
          id: entityId,
          workspaceId: call.workspaceId,
          kind: "project",
          scopeSpaceId: null,
          actorId: call.principal.principalId,
        })
        await transaction`insert into projects
          (id,workspace_id,name,slug,summary,owner_id,lead_ids,state,health,priority,start_date,
           target_date,completed_at,revision,created_at,updated_at)
          values (${entityId},${call.workspaceId},${payload.name},${payload.slug},${payload.summary},
            ${payload.ownerId},${transaction.array([...new Set(payload.leadIds)])},${payload.state},
            ${payload.health},${payload.priority},${payload.startDate},${payload.targetDate},
            ${call.restoredAt === undefined ? (payload.state === "completed" ? transaction`clock_timestamp()` : null) : transaction`${call.restoredAt}::timestamptz`},${revision},
            clock_timestamp(),clock_timestamp())`
        await replaceProjectSpaces(transaction, call, entityId, payload.participatingSpaceIds)
        await updateProjectSearchDocument(transaction, call.workspaceId, entityId, revision)
        return record(
          "project",
          entityId,
          revision,
          "entity.created",
          await projectSnapshot(transaction, entityId),
        )
      },
    )
  }

  #updateProject(call: CommandCall): Promise<MutationResult> {
    const payload = ProjectUpdatePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "project.manage", entityId),
      async (transaction, revision) => {
        const dates = await transaction<
          { readonly start_date: string | null; readonly target_date: string | null }[]
        >`select start_date::text,target_date::text from projects where id=${entityId}`
        const currentDates = dates[0]
        if (currentDates === undefined) throw new CommandInvariantError("project_not_found")
        requireDateOrder(
          payload.startDate === undefined ? currentDates.start_date : payload.startDate,
          payload.targetDate === undefined ? currentDates.target_date : payload.targetDate,
          "project_date_order_invalid",
        )
        if (payload.ownerId !== undefined) {
          await requireProjectOwner(transaction, call.workspaceId, payload.ownerId)
        }
        if (payload.leadIds !== undefined) {
          for (const leadId of new Set(payload.leadIds)) {
            await requireActiveHuman(transaction, call.workspaceId, leadId)
          }
        }
        await transaction`update projects set name=coalesce(${payload.name ?? null},name),
          slug=coalesce(${payload.slug ?? null},slug),summary=coalesce(${payload.summary ?? null},summary),
          owner_id=coalesce(${payload.ownerId ?? null},owner_id),
          lead_ids=coalesce(${payload.leadIds === undefined ? null : transaction.array([...new Set(payload.leadIds)])},lead_ids),
          state=coalesce(${payload.state ?? null},state),health=coalesce(${payload.health ?? null},health),
          priority=coalesce(${payload.priority ?? null},priority),
          start_date=case when ${payload.startDate !== undefined} then ${payload.startDate ?? null} else start_date end,
          target_date=case when ${payload.targetDate !== undefined} then ${payload.targetDate ?? null} else target_date end,
          completed_at=case when ${payload.state === "completed"} then coalesce(completed_at,clock_timestamp())
            when ${payload.state !== undefined} then null else completed_at end,
          revision=${revision},updated_at=clock_timestamp() where id=${entityId}`
        if (payload.participatingSpaceIds !== undefined) {
          await replaceProjectSpaces(transaction, call, entityId, payload.participatingSpaceIds)
        }
        await updateProjectSearchDocument(transaction, call.workspaceId, entityId, revision)
        return record(
          "project",
          entityId,
          revision,
          "entity.updated",
          await projectSnapshot(transaction, entityId),
        )
      },
    )
  }

  #setProjectArchive(call: CommandCall, archived: boolean): Promise<MutationResult> {
    ArchivePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "project.manage", entityId),
      async (transaction, revision) => {
        await transaction`update projects set archived_at=${archived ? (call.restoredAt === undefined ? transaction`clock_timestamp()` : transaction`${call.restoredAt}::timestamptz`) : null},
          revision=${revision},updated_at=clock_timestamp() where id=${entityId}`
        await updateProjectSearchDocument(transaction, call.workspaceId, entityId, revision)
        return record(
          "project",
          entityId,
          revision,
          archived ? "entity.archived" : "entity.restored",
          await projectSnapshot(transaction, entityId),
        )
      },
    )
  }
}

function mutationInput(
  call: CommandCall,
  permission: "space.manage" | "project.manage",
  targetEntityId: string | null,
) {
  return { ...call, permission, targetEntityId }
}

function required(value: string | null): string {
  if (value === null) throw new CommandInvariantError("resource_id_required")
  return value
}
