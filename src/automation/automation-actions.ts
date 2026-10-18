import type { TransactionSql } from "postgres"
import { z } from "zod"
import type { AutomationActionSchema } from "../contracts/automation/index.ts"
import { CommandInvariantError, EntityNotFoundError } from "../entities/errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { R4CommandService } from "../pm/commands/service.ts"
import { IntakeService } from "./intake-service.ts"

const EntityRowSchema = z.strictObject({
  kind: z.enum(["work_item", "project"]),
  current_revision: z.coerce.number().int().positive(),
})

export type AutomationRunContext = {
  readonly id: string
  readonly ruleId: string
  readonly workspaceId: string
  readonly principal: AuthenticatedPrincipal
}

export async function executeAutomationAction(
  transaction: TransactionSql,
  run: AutomationRunContext,
  action: z.infer<typeof AutomationActionSchema>,
  ordinal: number,
  now: Date,
): Promise<void> {
  switch (action.kind) {
    case "webhook":
      await queueWebhook(transaction, run, action.endpointId, action.body, ordinal, now)
      return
    case "create_intake":
      await createIntake(transaction, run, action, ordinal)
      return
    case "archive":
      await archiveEntity(transaction, run, action.entityId, ordinal)
      return
    default:
      return assertNever(action)
  }
}

async function archiveEntity(
  transaction: TransactionSql,
  run: AutomationRunContext,
  entityId: string,
  ordinal: number,
): Promise<void> {
  const rows = await transaction`select kind,current_revision from entities
    where workspace_id=${run.workspaceId} and id=${entityId}`
  const parsed = EntityRowSchema.safeParse(rows[0])
  if (!parsed.success) throw new EntityNotFoundError(entityId)
  const action = parsed.data.kind === "work_item" ? "work-item.archive" : "project.archive"
  await new R4CommandService(transaction).execute({
    workspaceId: run.workspaceId,
    principal: run.principal,
    commandId: actionKey(run.id, ordinal),
    idempotencyKey: actionKey(run.id, ordinal),
    baseRevision: parsed.data.current_revision,
    action,
    route: "automation-worker",
    resourceId: entityId,
    parentId: null,
    payload: {},
  })
}

async function createIntake(
  transaction: TransactionSql,
  run: AutomationRunContext,
  action: Extract<z.infer<typeof AutomationActionSchema>, { readonly kind: "create_intake" }>,
  ordinal: number,
): Promise<void> {
  const key = actionKey(run.id, ordinal)
  await new IntakeService(transaction).execute({
    workspaceId: run.workspaceId,
    principal: run.principal,
    commandId: key,
    idempotencyKey: key,
    baseRevision: null,
    action: "intake.create",
    route: "automation-worker",
    resourceId: null,
    parentId: null,
    payload: {
      source: "agent",
      sourceRef: key,
      targetSpaceId: action.targetSpaceId,
      title: action.title,
      body: action.body,
      suggestedDestination: null,
    },
  })
}

async function queueWebhook(
  transaction: TransactionSql,
  run: AutomationRunContext,
  endpointId: string,
  body: Readonly<Record<string, unknown>>,
  ordinal: number,
  now: Date,
): Promise<void> {
  const rows = await transaction<
    { readonly url: string }[]
  >`select endpoint_url url from extension_installations
    where workspace_id=${run.workspaceId} and id=${endpointId} and enabled`
  const url = rows[0]?.url
  if (url === undefined) throw new EntityNotFoundError(endpointId)
  await transaction`insert into outgoing_https_requests
    (workspace_id,idempotency_key,endpoint_kind,endpoint_id,url,method,body,state,available_at,created_at)
    values (${run.workspaceId},${actionKey(run.id, ordinal)},'extension',${endpointId},${url},'POST',
      ${JSON.stringify(body)}::text::jsonb,'pending',${now.toISOString()},${now.toISOString()})
    on conflict(workspace_id,idempotency_key) do nothing`
}

function actionKey(runId: string, ordinal: number): string {
  return `automation:${runId}:${ordinal}`
}
function assertNever(value: never): never {
  throw new CommandInvariantError(`unsupported_automation_action:${JSON.stringify(value)}`)
}
