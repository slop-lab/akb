import { createHash } from "node:crypto"
import { z } from "zod"
import {
  CycleCreateSchema,
  CycleRolloverSchema,
  CycleUpdateSchema,
} from "../contracts/planning/index.ts"
import type {
  BatchMutationResult,
  CommandTarget,
  CommandUnitOfWork,
} from "../entities/command-unit-of-work.ts"
import { CommandInvariantError } from "../entities/errors.ts"
import type { MutationRecord } from "../entities/mutation-types.ts"
import {
  captureCycleMetrics,
  cycleSnapshot,
  requireSameCycleSpace,
  rolloverWork,
} from "./cycle-rollover.ts"
import {
  addDependency,
  insertPlanningEntity,
  planningRecord,
  requireAccess,
  targetRevision,
} from "./persistence.ts"
import type { PlanningCommandCall } from "./types.ts"
import { planningWorkRecord } from "./work-assignment.ts"

const EmptySchema = z.strictObject({})

export class CycleCommands {
  readonly #unit: CommandUnitOfWork

  constructor(unit: CommandUnitOfWork) {
    this.#unit = unit
  }

  execute(call: PlanningCommandCall): Promise<BatchMutationResult> {
    switch (call.action) {
      case "cycle.create":
        return this.#create(call)
      case "cycle.update":
        return this.#update(call)
      case "cycle.activate":
        return this.#activate(call)
      case "cycle.rollover":
        return this.#rollover(call)
      default:
        throw new CommandInvariantError("unsupported_cycle_action")
    }
  }

  #create(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = CycleCreateSchema.parse(call.payload)
    const spaceId = required(call.parentId)
    const id = stableId(call, "cycle")
    return this.#unit.execute(
      input(call, id),
      [target(id, null, "space.manage")],
      async (tx, targets) => {
        const space = await tx<
          { readonly id: string }[]
        >`select stable_space_entity_id(${call.workspaceId},${spaceId}) id`
        const spaceEntityId = required(space[0]?.id ?? null)
        await requireAccess(tx, access(call, spaceEntityId, "space.manage"))
        await tx`select pg_advisory_xact_lock(hashtextextended(${`${call.workspaceId}:${spaceId}:cycles`},0))`
        const sequenceRows = await tx<{ readonly sequence: string | number }[]>`
        select coalesce(max(sequence),0)+1 sequence from cycles
        where workspace_id=${call.workspaceId} and space_id=${spaceId}`
        const sequence = z.coerce.number().int().positive().parse(sequenceRows[0]?.sequence)
        await insertPlanningEntity(tx, entity(call, id, "cycle", spaceId))
        await tx`insert into cycles
        (id,workspace_id,space_id,sequence,name,start_date,end_date,status,goal,capacity_hint,
         rollover_policy,revision,created_at,updated_at)
        values (${id},${call.workspaceId},${spaceId},${sequence},${payload.name},${payload.startDate},
          ${payload.endDate},'upcoming',${payload.goal},${payload.capacityHint},${payload.rolloverPolicy},
          1,clock_timestamp(),clock_timestamp())`
        await addDependency(tx, id, spaceEntityId)
        return {
          primaryEntityId: id,
          records: [
            planningRecord({
              id,
              kind: "cycle",
              revision: targetRevision(targets, id),
              snapshot: await cycleSnapshot(tx, id),
            }),
          ],
        }
      },
    )
  }

  #update(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = CycleUpdateSchema.parse(call.payload)
    const id = required(call.resourceId)
    return this.#unit.execute(
      input(call, id),
      [target(id, call.baseRevision, "space.manage")],
      async (tx, targets) => {
        const current = await tx<{ readonly start_date: string; readonly end_date: string }[]>`
        select start_date::text,end_date::text from cycles where id=${id}`
        const row = current[0]
        if (row === undefined) throw new CommandInvariantError("cycle_not_found")
        const start = payload.startDate ?? row.start_date
        const end = payload.endDate ?? row.end_date
        if (start > end) throw new CommandInvariantError("cycle_date_order_invalid")
        const revision = targetRevision(targets, id)
        await tx`update cycles set name=coalesce(${payload.name ?? null},name),
        start_date=coalesce(${payload.startDate ?? null},start_date),end_date=coalesce(${payload.endDate ?? null},end_date),
        status=coalesce(${payload.status ?? null},status),goal=coalesce(${payload.goal ?? null},goal),
        capacity_hint=case when ${payload.capacityHint !== undefined} then ${payload.capacityHint ?? null} else capacity_hint end,
        rollover_policy=coalesce(${payload.rolloverPolicy ?? null},rollover_policy),revision=${revision},
        updated_at=clock_timestamp() where id=${id}`
        return {
          primaryEntityId: id,
          records: [
            planningRecord({ id, kind: "cycle", revision, snapshot: await cycleSnapshot(tx, id) }),
          ],
        }
      },
    )
  }

  #activate(call: PlanningCommandCall): Promise<BatchMutationResult> {
    EmptySchema.parse(call.payload)
    const id = required(call.resourceId)
    return this.#unit.execute(
      input(call, id),
      [target(id, call.baseRevision, "space.manage")],
      async (tx, targets) => {
        const revision = targetRevision(targets, id)
        await tx`update cycles set status='active',revision=${revision},updated_at=clock_timestamp() where id=${id}`
        return {
          primaryEntityId: id,
          records: [
            planningRecord({ id, kind: "cycle", revision, snapshot: await cycleSnapshot(tx, id) }),
          ],
        }
      },
    )
  }

  #rollover(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = CycleRolloverSchema.parse(call.payload)
    const sourceId = required(call.resourceId)
    const targets: readonly CommandTarget[] = [
      target(sourceId, call.baseRevision, "space.manage"),
      target(payload.targetCycleId, payload.targetCycleRevision, "space.manage"),
      ...payload.workItems.map((work) => target(work.id, work.revision, "work.update")),
    ]
    return this.#unit.execute(input(call, sourceId), targets, async (tx, locked) => {
      await requireSameCycleSpace(tx, sourceId, payload.targetCycleId)
      const records: MutationRecord[] = []
      for (const work of payload.workItems) {
        await rolloverWork(tx, {
          sourceId,
          targetId: payload.targetCycleId,
          workId: work.id,
          actorId: call.principal.principalId,
        })
        const revision = targetRevision(locked, work.id)
        await tx`update work_item_planning set revision=${revision},updated_at=clock_timestamp()
          where work_item_id=${work.id}`
        records.push(await planningWorkRecord(tx, { call, workId: work.id, revision }))
      }
      const sourceRevision = targetRevision(locked, sourceId)
      const targetCycleRevision = targetRevision(locked, payload.targetCycleId)
      await captureCycleMetrics(tx, {
        cycleId: sourceId,
        revision: sourceRevision,
        carryOver: payload.workItems.length,
      })
      await tx`update cycles set status='completed',revision=${sourceRevision},updated_at=clock_timestamp() where id=${sourceId}`
      await tx`update cycles set status='active',revision=${targetCycleRevision},updated_at=clock_timestamp() where id=${payload.targetCycleId}`
      records.unshift(
        planningRecord({
          id: payload.targetCycleId,
          kind: "cycle",
          revision: targetCycleRevision,
          snapshot: await cycleSnapshot(tx, payload.targetCycleId),
        }),
      )
      records.unshift(
        planningRecord({
          id: sourceId,
          kind: "cycle",
          revision: sourceRevision,
          snapshot: await cycleSnapshot(tx, sourceId),
          result: { id: sourceId, rolledOver: payload.workItems.length },
        }),
      )
      return { primaryEntityId: sourceId, records }
    })
  }
}

function input(call: PlanningCommandCall, primaryEntityId: string) {
  return { ...call, primaryEntityId }
}
function target(
  entityId: string,
  expectedRevision: number | null,
  permission: "space.manage" | "work.update",
): CommandTarget {
  return { entityId, expectedRevision, permission }
}
function access(call: PlanningCommandCall, entityId: string, permission: "space.manage") {
  return {
    workspaceId: call.workspaceId,
    principalId: call.principal.principalId,
    entityId,
    permission,
  }
}
function entity(call: PlanningCommandCall, id: string, kind: string, spaceId: string | null) {
  return { id, workspaceId: call.workspaceId, kind, spaceId, actorId: call.principal.principalId }
}
function stableId(call: PlanningCommandCall, kind: string): string {
  return `${kind}:${createHash("sha256")
    .update(`${call.workspaceId}:${call.idempotencyKey}`)
    .digest("hex")}`
}
function required(value: string | null): string {
  if (value === null) throw new CommandInvariantError("planning_resource_required")
  return value
}
