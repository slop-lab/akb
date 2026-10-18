import type { TransactionSql } from "postgres"
import {
  NotificationPreferencesUpdateSchema,
  NotificationReadSchema,
  TemplateApplySchema,
  TemplateCreateSchema,
  TemplateRevisionCreateSchema,
} from "../contracts/planning/index.ts"
import type { BatchMutationResult, CommandUnitOfWork } from "../entities/command-unit-of-work.ts"
import { CommandInvariantError } from "../entities/errors.ts"
import {
  addDependency,
  insertPlanningEntity,
  planningRecord,
  requireAccess,
  rowObject,
  stablePlanningEntityId,
  targetRevision,
} from "./persistence.ts"
import type { PlanningCommandCall } from "./types.ts"

export class TemplateNotificationCommands {
  readonly #unit: CommandUnitOfWork

  constructor(unit: CommandUnitOfWork) {
    this.#unit = unit
  }

  execute(call: PlanningCommandCall): Promise<BatchMutationResult> {
    switch (call.action) {
      case "template.create":
        return this.#createTemplate(call)
      case "template.revise":
        return this.#reviseTemplate(call)
      case "template.apply":
        return this.#applyTemplate(call)
      case "notification-preferences.create":
        return this.#createPreferences(call)
      case "notification-preferences.update":
        return this.#updatePreferences(call)
      case "notification.read":
        return this.#readNotification(call)
      default:
        throw new CommandInvariantError("unsupported_template_notification_action")
    }
  }

  #createTemplate(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = TemplateCreateSchema.parse(call.payload)
    const id = stablePlanningEntityId("template", call.workspaceId, call.idempotencyKey)
    return this.#unit.execute(
      command(call, id),
      [target(id, null, "work.create")],
      async (tx, targets) => {
        await insertPlanningEntity(tx, entity(call, id, "planning_template"))
        await tx`insert into planning_templates
        (id,workspace_id,name,kind,current_revision,created_by,created_at,updated_at)
        values (${id},${call.workspaceId},${payload.name},${payload.kind},1,
          ${call.principal.principalId},clock_timestamp(),clock_timestamp())`
        await tx`insert into planning_template_revisions
        (template_id,revision,content,actor_id,created_at)
          values (${id},1,${JSON.stringify(payload.content)}::jsonb,${call.principal.principalId},clock_timestamp())`
        return one(
          id,
          planningRecord({
            id,
            kind: "planning_template",
            revision: targetRevision(targets, id),
            snapshot: await templateSnapshot(tx, id),
          }),
        )
      },
    )
  }

  #reviseTemplate(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = TemplateRevisionCreateSchema.parse(call.payload)
    const id = required(call.resourceId)
    return this.#unit.execute(
      command(call, id),
      [target(id, call.baseRevision, "work.update")],
      async (tx, targets) => {
        const revision = targetRevision(targets, id)
        await tx`update planning_templates set current_revision=${revision},updated_at=clock_timestamp() where id=${id}`
        await tx`insert into planning_template_revisions
        (template_id,revision,content,actor_id,created_at)
          values (${id},${revision},${JSON.stringify(payload.content)}::jsonb,${call.principal.principalId},clock_timestamp())`
        return one(
          id,
          planningRecord({
            id,
            kind: "planning_template",
            revision,
            snapshot: await templateSnapshot(tx, id),
          }),
        )
      },
    )
  }

  #applyTemplate(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = TemplateApplySchema.parse(call.payload)
    const templateId = required(call.parentId)
    const id = stablePlanningEntityId("template-application", call.workspaceId, call.idempotencyKey)
    return this.#unit.execute(
      command(call, id),
      [target(id, null, "work.create")],
      async (tx, targets) => {
        await requireAccess(tx, {
          workspaceId: call.workspaceId,
          principalId: call.principal.principalId,
          entityId: templateId,
          permission: "work.read",
        })
        await requireTarget(tx, call, payload.targetEntityId, payload.targetKind)
        const revisionRows = await tx`select 1 from planning_template_revisions
        where template_id=${templateId} and revision=${payload.templateRevision}`
        if (revisionRows.length !== 1)
          throw new CommandInvariantError("template_revision_not_found")
        await insertPlanningEntity(tx, entity(call, id, "template_application"))
        await tx`insert into planning_template_applications
        (id,workspace_id,target_entity_id,target_kind,template_id,template_revision,applied_at)
        values (${id},${call.workspaceId},${payload.targetEntityId},${payload.targetKind},
          ${templateId},${payload.templateRevision},clock_timestamp())`
        await addDependency(tx, id, templateId)
        await addDependency(tx, id, payload.targetEntityId)
        return one(
          id,
          planningRecord({
            id,
            kind: "template_application",
            revision: targetRevision(targets, id),
            snapshot: { id, templateId, ...payload },
          }),
        )
      },
    )
  }

  #createPreferences(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = NotificationPreferencesUpdateSchema.parse(call.payload)
    const id = stablePlanningEntityId(
      "notification-settings",
      call.workspaceId,
      call.principal.principalId,
    )
    return this.#unit.execute(
      command(call, id),
      [target(id, null, "work.read")],
      async (tx, targets) => {
        await insertPlanningEntity(tx, entity(call, id, "notification_settings"))
        await tx`insert into notification_settings (id,workspace_id,principal_id,revision)
        values (${id},${call.workspaceId},${call.principal.principalId},1)`
        await replacePreferences(tx, call, id, payload.preferences)
        return one(
          id,
          planningRecord({
            id,
            kind: "notification_settings",
            revision: targetRevision(targets, id),
            snapshot: await preferencesSnapshot(tx, id),
          }),
        )
      },
    )
  }

  #updatePreferences(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = NotificationPreferencesUpdateSchema.parse(call.payload)
    const id = required(call.resourceId)
    return this.#unit.execute(
      command(call, id),
      [target(id, call.baseRevision, "work.read")],
      async (tx, targets) => {
        const owned = await tx`select 1 from notification_settings where id=${id}
        and workspace_id=${call.workspaceId} and principal_id=${call.principal.principalId}`
        if (owned.length !== 1) throw new CommandInvariantError("notification_settings_not_owned")
        const revision = targetRevision(targets, id)
        await tx`update notification_settings set revision=${revision} where id=${id}`
        await replacePreferences(tx, call, id, payload.preferences)
        return one(
          id,
          planningRecord({
            id,
            kind: "notification_settings",
            revision,
            snapshot: await preferencesSnapshot(tx, id),
          }),
        )
      },
    )
  }

  #readNotification(call: PlanningCommandCall): Promise<BatchMutationResult> {
    const payload = NotificationReadSchema.parse(call.payload)
    const id = required(call.resourceId)
    return this.#unit.execute(
      command(call, id),
      [target(id, call.baseRevision, "work.read")],
      async (tx, targets) => {
        const rows = await tx<{ readonly sequence: number }[]>`
        update notifications set read_at=coalesce(read_at,clock_timestamp())
        where id=${payload.notificationId} and workspace_id=${call.workspaceId}
          and recipient_id=${call.principal.principalId} returning sequence`
        const notification = rows[0]
        if (notification === undefined || rows.length !== 1)
          throw new CommandInvariantError("notification_not_found")
        const revision = targetRevision(targets, id)
        await tx`update notification_settings set revision=${revision} where id=${id}`
        await tx`insert into notification_inbox_cursors
        (workspace_id,principal_id,last_sequence,updated_at)
        values (${call.workspaceId},${call.principal.principalId},${notification.sequence},clock_timestamp())
        on conflict (workspace_id,principal_id) do update set
          last_sequence=greatest(notification_inbox_cursors.last_sequence,excluded.last_sequence),
          updated_at=excluded.updated_at`
        return one(
          id,
          planningRecord({
            id,
            kind: "notification_settings",
            revision,
            snapshot: await preferencesSnapshot(tx, id),
            result: { id: payload.notificationId, read: true },
          }),
        )
      },
    )
  }
}

function command(call: PlanningCommandCall, primaryEntityId: string) {
  return { ...call, primaryEntityId }
}
function target(
  entityId: string,
  expectedRevision: number | null,
  permission: "work.create" | "work.update" | "work.read",
) {
  return { entityId, expectedRevision, permission }
}
function entity(call: PlanningCommandCall, id: string, kind: string) {
  return {
    id,
    workspaceId: call.workspaceId,
    kind,
    spaceId: null,
    actorId: call.principal.principalId,
  }
}
function one(primaryEntityId: string, record: ReturnType<typeof planningRecord>) {
  return { primaryEntityId, records: [record] }
}
function required(value: string | null): string {
  if (value === null) throw new CommandInvariantError("planning_resource_required")
  return value
}
async function templateSnapshot(tx: TransactionSql, id: string) {
  const rows =
    await tx`select template.id,template.name,template.kind,template.current_revision "currentRevision",revision.content from planning_templates template join planning_template_revisions revision on revision.template_id=template.id and revision.revision=template.current_revision where template.id=${id}`
  return rowObject(rows[0])
}
async function preferencesSnapshot(tx: TransactionSql, id: string) {
  const settings =
    await tx`select id,principal_id "principalId",revision from notification_settings where id=${id}`
  const preferences =
    await tx`select event_type "eventType",in_app "inApp" from notification_preferences where settings_id=${id} order by event_type`
  return { ...rowObject(settings[0]), preferences }
}
async function replacePreferences(
  tx: TransactionSql,
  call: PlanningCommandCall,
  id: string,
  preferences: readonly { readonly eventType: string; readonly inApp: boolean }[],
): Promise<void> {
  await tx`delete from notification_preferences where settings_id=${id}`
  for (const preference of preferences)
    await tx`insert into notification_preferences (settings_id,workspace_id,principal_id,event_type,in_app) values (${id},${call.workspaceId},${call.principal.principalId},${preference.eventType},${preference.inApp})`
}
async function requireTarget(
  tx: TransactionSql,
  call: PlanningCommandCall,
  entityId: string,
  kind: "work" | "project" | "page" | "agent_task",
): Promise<void> {
  const permission =
    kind === "project" ? "project.read" : kind === "page" ? "content.read" : "work.read"
  await requireAccess(tx, {
    workspaceId: call.workspaceId,
    principalId: call.principal.principalId,
    entityId,
    permission,
  })
}
