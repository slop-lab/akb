import type { Sql, TransactionSql } from "postgres"
import {
  IntakeAcceptSchema,
  IntakeCreateSchema,
  IntakeDispositionSchema,
} from "../contracts/automation/index.ts"
import { type BatchMutationResult, CommandUnitOfWork } from "../entities/command-unit-of-work.ts"
import { CommandInvariantError, EntityNotFoundError } from "../entities/errors.ts"
import type { FeatureCommandCall } from "../http/feature-command-router.ts"
import { requireSpaceAccess, stableEntityId } from "../pm/commands/helpers.ts"
import {
  appendLegacyRevision,
  requireAssignmentAccess,
  requireProjectAndLabels,
  requireState,
  validateAssignment,
  workRecord,
  workSnapshot,
} from "../pm/commands/work-item-command-persistence.ts"
import {
  addAutomationDependency,
  automationEntityId,
  automationRecord,
  insertAutomationEntity,
  jsonRow,
} from "./persistence.ts"

export type IntakeAction = "intake.create" | "intake.accept" | "intake.disposition"

export class IntakeService {
  readonly #unit: CommandUnitOfWork

  constructor(sql: Sql | TransactionSql) {
    this.#unit = new CommandUnitOfWork(sql)
  }

  execute(call: FeatureCommandCall<IntakeAction>): Promise<BatchMutationResult> {
    switch (call.action) {
      case "intake.create":
        return this.#create(call)
      case "intake.accept":
        return this.#accept(call)
      case "intake.disposition":
        return this.#dispose(call)
      default:
        return assertNever(call.action)
    }
  }

  #create(call: FeatureCommandCall<IntakeAction>): Promise<BatchMutationResult> {
    const value = IntakeCreateSchema.parse(call.payload)
    const id = automationEntityId("intake", call.workspaceId, call.idempotencyKey)
    return this.#unit.execute(command(call, id), [target(id, null, "work.create")], async (tx) => {
      await requireSpaceAccess(tx, {
        principal: call.principal,
        spaceId: value.targetSpaceId,
        permission: "work.create",
      })
      const targetSpaceEntityId = stableEntityId("space", call.workspaceId, value.targetSpaceId)
      await insertAutomationEntity(tx, {
        id,
        workspaceId: call.workspaceId,
        kind: "intake",
        spaceId: value.targetSpaceId,
        actorId: call.principal.principalId,
      })
      await tx`insert into intake_records
        (id,workspace_id,source,source_ref,submitter_id,target_space_id,title,body,state,
         suggested_destination,revision,created_at,updated_at)
        values (${id},${call.workspaceId},${value.source},${value.sourceRef},
          ${call.principal.principalId},${value.targetSpaceId},${value.title},${value.body},'new',
          ${value.suggestedDestination},1,clock_timestamp(),clock_timestamp())`
      await addAutomationDependency(tx, id, targetSpaceEntityId)
      const record = automationRecord({
        id,
        kind: "intake",
        revision: 1,
        snapshot: await snapshot(tx, id),
      })
      return { primaryEntityId: id, records: [record] }
    })
  }

  #accept(call: FeatureCommandCall<IntakeAction>): Promise<BatchMutationResult> {
    const value = IntakeAcceptSchema.parse(call.payload)
    const intakeId = required(call.resourceId)
    const workId = automationEntityId("work", call.workspaceId, call.idempotencyKey)
    return this.#unit.execute(
      command(call, intakeId),
      [target(intakeId, call.baseRevision, "work.update"), target(workId, null, "work.create")],
      async (tx) => {
        const intake = await intakeForUpdate(tx, call.workspaceId, intakeId)
        if (
          intake.state !== "new" &&
          intake.state !== "clarifying" &&
          intake.state !== "deferred"
        ) {
          throw new CommandInvariantError("intake_not_open")
        }
        const canonicalCall = workCreateCall(call)
        await requireSpaceAccess(tx, {
          principal: call.principal,
          spaceId: intake.target_space_id,
          permission: "work.create",
        })
        await requireAssignmentAccess(tx, canonicalCall, { spaceId: intake.target_space_id })
        await validateAssignment(tx, canonicalCall, value.ownerId, intake.target_space_id)
        await requireState(tx, canonicalCall, intake.target_space_id, value.workflowStateId)
        await requireProjectAndLabels(
          tx,
          canonicalCall,
          intake.target_space_id,
          value.projectId,
          [],
        )
        await insertAutomationEntity(tx, {
          id: workId,
          workspaceId: call.workspaceId,
          kind: "work_item",
          spaceId: intake.target_space_id,
          actorId: call.principal.principalId,
        })
        await tx`insert into work_items
          (id,workspace_id,space_id,title,state,accountable_owner_id,revision,created_at,updated_at)
          values (${workId},${call.workspaceId},${intake.target_space_id},${intake.title},'unstarted',
            ${value.ownerId},1,clock_timestamp(),clock_timestamp())`
        await tx`update work_item_pm set workflow_state_id=${value.workflowStateId},project_id=${value.projectId},
          description=${intake.body},item_type=${value.itemType},priority=${value.priority}
          where work_item_id=${workId}`
        await appendLegacyRevision(tx, workId)
        await tx`update intake_records set state='accepted',converted_work_item_id=${workId},revision=${(call.baseRevision ?? 0) + 1},updated_at=clock_timestamp() where id=${intakeId}`
        await addAutomationDependency(tx, intakeId, workId)
        const intakeRecord = automationRecord({
          id: intakeId,
          kind: "intake",
          revision: (call.baseRevision ?? 0) + 1,
          snapshot: await snapshot(tx, intakeId),
          result: { id: intakeId, workItemId: workId },
        })
        const work = workRecord(
          workId,
          1,
          "entity.created",
          await workSnapshot(tx, workId),
          (eventId, occurredAt) => appendLegacyWorkEvent(tx, call, workId, eventId, occurredAt),
        )
        return { primaryEntityId: intakeId, records: [intakeRecord, work] }
      },
    )
  }

  #dispose(call: FeatureCommandCall<IntakeAction>): Promise<BatchMutationResult> {
    const value = IntakeDispositionSchema.parse(call.payload)
    const id = required(call.resourceId)
    return this.#unit.execute(
      command(call, id),
      [target(id, call.baseRevision, "work.update")],
      async (tx) => {
        const intake = await intakeForUpdate(tx, call.workspaceId, id)
        if (
          intake.state === "accepted" ||
          intake.state === "declined" ||
          intake.state === "duplicate"
        )
          throw new CommandInvariantError("intake_not_open")
        const revision = (call.baseRevision ?? 0) + 1
        await tx`update intake_records set state=${value.state},
        disposition=${"reason" in value ? value.reason : "question" in value ? value.question : null},
        snooze_until=${"snoozeUntil" in value ? value.snoozeUntil : null},
        duplicate_of=${"duplicateOf" in value ? value.duplicateOf : null},revision=${revision},
        updated_at=clock_timestamp() where id=${id}`
        const record = automationRecord({
          id,
          kind: "intake",
          revision,
          snapshot: await snapshot(tx, id),
        })
        return { primaryEntityId: id, records: [record] }
      },
    )
  }
}

type IntakeRow = {
  readonly title: string
  readonly body: string
  readonly state: string
  readonly target_space_id: string
}
async function intakeForUpdate(
  tx: TransactionSql,
  workspaceId: string,
  id: string,
): Promise<IntakeRow> {
  const rows = await tx<
    IntakeRow[]
  >`select title,body,state,target_space_id from intake_records where workspace_id=${workspaceId} and id=${id} for update`
  const row = rows[0]
  if (row === undefined) throw new EntityNotFoundError(id)
  return row
}
async function snapshot(tx: TransactionSql, id: string) {
  const rows = await tx<
    { readonly snapshot: unknown }[]
  >`select to_jsonb(i) snapshot from intake_records i where id=${id}`
  return jsonRow(rows[0]?.snapshot)
}
function target(
  entityId: string,
  expectedRevision: number | null,
  permission: "work.create" | "work.update",
) {
  return { entityId, expectedRevision, permission }
}
function command(call: FeatureCommandCall<IntakeAction>, primaryEntityId: string) {
  return { ...call, primaryEntityId }
}
function workCreateCall(call: FeatureCommandCall<IntakeAction>) {
  return { ...call, action: "work-item.create" as const }
}
function required(value: string | null): string {
  if (value === null) throw new CommandInvariantError("intake_id_required")
  return value
}
function assertNever(value: never): never {
  throw new CommandInvariantError(`unsupported_intake_action:${value}`)
}

async function appendLegacyWorkEvent(
  tx: TransactionSql,
  call: FeatureCommandCall<IntakeAction>,
  workId: string,
  eventId: string,
  occurredAt: string,
): Promise<void> {
  const rows = await tx<
    { readonly sequence: number }[]
  >`insert into workspace_event_sequences values (${call.workspaceId},1)
    on conflict(workspace_id) do update set last_sequence=workspace_event_sequences.last_sequence+1
    returning last_sequence::integer sequence`
  const sequence = rows[0]?.sequence
  if (sequence === undefined) throw new CommandInvariantError("legacy_event_sequence_missing")
  await tx`insert into domain_events
    (id,workspace_id,space_id,sequence,event_type,occurred_at,actor_id,subject_id,subject_revision,changed_fields)
    select ${eventId},workspace_id,space_id,${sequence},'work_item.created',${occurredAt},
      ${call.principal.principalId},id,1,null from work_items where id=${workId}`
}
