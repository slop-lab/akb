import type { TransactionSql } from "postgres"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { RuntimeNotFoundError } from "./errors.ts"

export async function requireHumanRunPermission(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  permission: "run.delegate" | "run.inspect",
): Promise<void> {
  if (!(await lockAuthenticatedPrincipal(transaction, principal))) throw new RuntimeNotFoundError()
  const rows = await transaction`select 1 from membership_permissions where
    workspace_id=${principal.workspaceId} and principal_id=${principal.principalId}
    and permission=${permission}`
  if (rows.length !== 1) throw new RuntimeNotFoundError()
}

export async function requireInspectableRun(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  runId: string,
): Promise<void> {
  await requireRunSubjectAccess(transaction, principal, runId, "run.inspect")
}

export async function requireDelegatableRun(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  runId: string,
): Promise<void> {
  await requireRunSubjectAccess(transaction, principal, runId, "run.delegate")
}

export async function requireStartSubjectAccess(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  subjectRef: string,
  installationPrincipalId: string,
): Promise<void> {
  const rows = await transaction`select 1 from entities e
    where e.workspace_id=${principal.workspaceId} and e.id=${subjectRef}
      and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},case e.kind
        when 'project' then 'project.read' when 'space' then 'space.read'
        when 'workflow' then 'space.read' when 'workflow_state' then 'space.read'
        when 'label' then 'space.read' when 'saved_view' then 'view.read'
        when 'comment' then 'work.read' when 'thread' then 'work.read'
        when 'relation' then 'work.read' when 'work_item' then 'work.read' end)
      and entity_access_allowed(e.workspace_id,e.id,${installationPrincipalId},case e.kind
        when 'project' then 'project.read' when 'space' then 'space.read'
        when 'workflow' then 'space.read' when 'workflow_state' then 'space.read'
        when 'label' then 'space.read' when 'saved_view' then 'view.read'
        when 'comment' then 'work.read' when 'thread' then 'work.read'
        when 'relation' then 'work.read' when 'work_item' then 'work.read' end)
    for share of e`
  if (rows.length !== 1) throw new RuntimeNotFoundError()
}

async function requireRunSubjectAccess(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  runId: string,
  permission: "run.delegate" | "run.inspect",
): Promise<void> {
  await requireHumanRunPermission(transaction, principal, permission)
  const rows = await transaction`select 1 from runtime_runs r join entities e
    on e.workspace_id=r.workspace_id and e.id=r.subject_ref
    where r.workspace_id=${principal.workspaceId} and r.id=${runId}
      and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},case e.kind
        when 'project' then 'project.read' when 'space' then 'space.read'
        when 'workflow' then 'space.read' when 'workflow_state' then 'space.read'
        when 'label' then 'space.read' when 'saved_view' then 'view.read'
        when 'comment' then 'work.read' when 'thread' then 'work.read'
        when 'relation' then 'work.read' when 'work_item' then 'work.read' end)
    for share of r,e`
  if (rows.length !== 1) throw new RuntimeNotFoundError()
}
