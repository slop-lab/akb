import type { TransactionSql } from "postgres"
import { z } from "zod"
import {
  ArchivePayloadSchema,
  EntityAccessPayloadSchema,
  SavedViewCreatePayloadSchema,
  SavedViewUpdatePayloadSchema,
} from "../../contracts/r4/command-payloads.ts"
import { CommandInvariantError, EntityNotFoundError } from "../../entities/errors.ts"
import type { EntityMutationEngine } from "../../entities/mutation-engine.ts"
import type { JsonObject, MutationRecord, MutationResult } from "../../entities/mutation-types.ts"
import { entityAccessRecord, requireAccessEntityKind } from "./entity-access-record.ts"
import { insertEntity, newEntityId, requireActiveHuman, requireSpaceAccess } from "./helpers.ts"
import type { CommandCall } from "./types.ts"

const SnapshotRowSchema = z.strictObject({ snapshot: z.record(z.string(), z.unknown()) })
const AccessRowSchema = z.strictObject({
  access: z.enum(["private", "space", "workspace"]),
  scope_space_id: z.string().nullable(),
})

export class ViewAccessCommandService {
  readonly engine: EntityMutationEngine

  constructor(engine: EntityMutationEngine) {
    this.engine = engine
  }

  execute(call: CommandCall): Promise<MutationResult> {
    switch (call.action) {
      case "saved-view.create":
        return this.#createView(call)
      case "saved-view.update":
        return this.#updateView(call)
      case "saved-view.archive":
        return this.#archiveView(call)
      case "entity.access":
        return this.#setEntityAccess(call)
      default:
        throw new CommandInvariantError("unsupported_view_access_action")
    }
  }

  #createView(call: CommandCall): Promise<MutationResult> {
    const payload = SavedViewCreatePayloadSchema.parse(call.payload)
    const entityId = newEntityId("view")
    return this.engine.mutate(
      mutationInput(call, "view.manage", null),
      async (transaction, revision) => {
        if (payload.access === "space" && payload.scopeSpaceId === null) {
          throw new CommandInvariantError("space_view_requires_scope")
        }
        if (payload.access !== "space" && payload.scopeSpaceId !== null) {
          throw new CommandInvariantError("only_space_view_has_scope")
        }
        if (payload.scopeSpaceId !== null) {
          await requireSpaceAccess(transaction, {
            principal: call.principal,
            spaceId: payload.scopeSpaceId,
            permission: "view.manage",
          })
        }
        await insertEntity(transaction, {
          id: entityId,
          workspaceId: call.workspaceId,
          kind: "saved_view",
          scopeSpaceId: payload.scopeSpaceId,
          actorId: call.principal.principalId,
        })
        await transaction`insert into saved_views
          (id,workspace_id,owner_id,name,access,scope_space_id,definition,revision)
          values (${entityId},${call.workspaceId},${call.principal.principalId},${payload.name},
            ${payload.access},${payload.scopeSpaceId},${transaction.json(payload.definition)},${revision})`
        if (payload.access === "private") await restrictViewToOwner(transaction, call, entityId)
        return viewRecord(
          entityId,
          revision,
          "entity.created",
          await viewSnapshot(transaction, entityId),
        )
      },
    )
  }

  #updateView(call: CommandCall): Promise<MutationResult> {
    const payload = SavedViewUpdatePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "view.manage", entityId),
      async (transaction, revision) => {
        await requirePrivateOwner(transaction, call, entityId)
        const currentRows = await transaction`select access,scope_space_id from saved_views
          where id=${entityId}`
        const current = AccessRowSchema.parse(currentRows[0])
        const access = payload.access ?? current.access
        const scopeSpaceId =
          payload.scopeSpaceId === undefined ? current.scope_space_id : payload.scopeSpaceId
        if ((access === "space") !== (scopeSpaceId !== null)) {
          throw new CommandInvariantError("saved_view_scope_mismatch")
        }
        if (scopeSpaceId !== null) {
          await requireSpaceAccess(transaction, {
            principal: call.principal,
            spaceId: scopeSpaceId,
            permission: "view.manage",
          })
        }
        await transaction`update saved_views set name=coalesce(${payload.name ?? null},name),
          access=coalesce(${payload.access ?? null},access),
          scope_space_id=case when ${payload.scopeSpaceId !== undefined} then ${payload.scopeSpaceId ?? null}
            else scope_space_id end,
          definition=coalesce(${payload.definition === undefined ? null : transaction.json(payload.definition)},definition),
          revision=${revision} where id=${entityId}`
        if (access === "private") await restrictViewToOwner(transaction, call, entityId)
        else
          await transaction`update entity_acl_policies set mode='inherit' where entity_id=${entityId}`
        return viewRecord(
          entityId,
          revision,
          "entity.updated",
          await viewSnapshot(transaction, entityId),
        )
      },
    )
  }

  #archiveView(call: CommandCall): Promise<MutationResult> {
    ArchivePayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "view.manage", entityId),
      async (transaction, revision) => {
        await requirePrivateOwner(transaction, call, entityId)
        await transaction`update saved_views set archived_at=${call.restoredAt === undefined ? transaction`clock_timestamp()` : transaction`${call.restoredAt}::timestamptz`},revision=${revision}
          where id=${entityId}`
        return viewRecord(
          entityId,
          revision,
          "entity.archived",
          await viewSnapshot(transaction, entityId),
        )
      },
    )
  }

  #setEntityAccess(call: CommandCall): Promise<MutationResult> {
    const payload = EntityAccessPayloadSchema.parse(call.payload)
    const entityId = required(call.resourceId)
    return this.engine.mutate(
      mutationInput(call, "acl.manage", entityId),
      async (transaction, revision) => {
        const kind = await requireAccessEntityKind(transaction, entityId)
        await transaction`update entity_acl_policies set mode=${payload.mode} where entity_id=${entityId}`
        await transaction`delete from entity_acl_allowances where entity_id=${entityId}`
        for (const allowance of payload.allowances) {
          await requireActiveHuman(transaction, call.workspaceId, allowance.principalId)
          for (const permission of new Set(allowance.permissions)) {
            await transaction`insert into entity_acl_allowances (entity_id,principal_id,permission)
              values (${entityId},${allowance.principalId},${permission})`
          }
        }
        const retained =
          await transaction`select 1 where entity_access_allowed(${call.workspaceId},${entityId},
          ${call.principal.principalId},'acl.manage')`
        if (retained.length !== 1) throw new CommandInvariantError("caller_must_retain_acl_manage")
        return entityAccessRecord(transaction, call, { entityId, revision, kind })
      },
    )
  }
}

function mutationInput(
  call: CommandCall,
  permission: "view.manage" | "acl.manage",
  targetEntityId: string | null,
) {
  return { ...call, permission, targetEntityId }
}

function required(value: string | null): string {
  if (value === null) throw new CommandInvariantError("resource_id_required")
  return value
}

async function restrictViewToOwner(
  transaction: TransactionSql,
  call: CommandCall,
  entityId: string,
) {
  await transaction`update entity_acl_policies set mode='restricted' where entity_id=${entityId}`
  await transaction`delete from entity_acl_allowances where entity_id=${entityId}`
  await transaction`insert into entity_acl_allowances (entity_id,principal_id,permission) values
    (${entityId},${call.principal.principalId},'view.read'),
    (${entityId},${call.principal.principalId},'view.manage')`
}

async function requirePrivateOwner(
  transaction: TransactionSql,
  call: CommandCall,
  entityId: string,
) {
  const rows = await transaction`select 1 from saved_views where id=${entityId}
    and (access <> 'private' or owner_id=${call.principal.principalId})`
  if (rows.length !== 1) throw new EntityNotFoundError(entityId)
}

async function viewSnapshot(transaction: TransactionSql, id: string) {
  const rows = await transaction`select to_jsonb(v) snapshot from saved_views v where id=${id}`
  return SnapshotRowSchema.parse(rows[0]).snapshot
}

function viewRecord(
  entityId: string,
  revision: number,
  eventType: MutationRecord["eventType"],
  snapshot: JsonObject,
): MutationRecord {
  return {
    entityId,
    kind: "saved_view",
    revision,
    schemaVersion: "saved-view.r4.v1",
    eventType,
    snapshot,
    eventData: { id: entityId },
    result: { id: entityId },
  }
}
