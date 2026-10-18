import { createHash, randomUUID } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import type { RunStartResponse, StartRunInput } from "../contracts/runtime/index.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { issueRunToken, runTokenDigest } from "./credentials.ts"
import { RuntimeCapabilityError, RuntimeConflictError, RuntimeNotFoundError } from "./errors.ts"
import { toJsonValue } from "./json.ts"
import { runStartResponse, runtimeFingerprint } from "./run-start.ts"
import {
  requireDelegatableRun,
  requireHumanRunPermission,
  requireStartSubjectAccess,
} from "./subject-authority.ts"

const InstallationRowSchema = z.strictObject({
  principal_id: z.string(),
  definition_revision_id: z.string(),
  runtime_endpoint_id: z.string(),
  capabilities: z.array(z.string()),
  scopes: z.array(z.string()),
  permissions: z.array(z.string()),
  supported_capabilities: z.array(z.string()),
  required_capabilities: z.array(z.string()),
  current_permissions: z.array(z.string()),
  heartbeat_seconds: z.coerce.number().int(),
})
const RunRowSchema = z.strictObject({
  id: z.string(),
  workspace_id: z.string(),
  installation_id: z.string(),
  subject_ref: z.string(),
  directive_ref: z.string(),
  state: z.string(),
  generation: z.coerce.number().int(),
  depth: z.coerce.number().int(),
})

export class RuntimeControl {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  async start(principal: AuthenticatedPrincipal, input: StartRunInput): Promise<RunStartResponse> {
    return this.#sql.begin(async (transaction) => {
      await requireHumanRunPermission(transaction, principal, "run.delegate")
      return startInTransaction(transaction, principal, input)
    })
  }

  async cancel(principal: AuthenticatedPrincipal, runId: string): Promise<void> {
    await this.#sql.begin(async (transaction) => {
      await requireDelegatableRun(transaction, principal, runId)
      const rows = await transaction`with recursive descendants as (
          select id from runtime_runs where workspace_id=${principal.workspaceId} and id=${runId}
          union all select child.id from runtime_runs child join descendants parent
            on child.parent_run_id=parent.id where child.depth<=4
        ) update runtime_runs set state='canceled',cancel_requested_at=clock_timestamp(),
          token_expires_at=clock_timestamp(),updated_at=clock_timestamp()
        where id in (select id from descendants)
          and state not in ('completed','failed','canceled') returning id`
      if (rows.length === 0) throw new RuntimeNotFoundError()
      await transaction`update runtime_leases set status='released'
        where run_id in (select id from runtime_runs where workspace_id=${principal.workspaceId}
          and (id=${runId} or parent_run_id=${runId})) and status in ('issued','acknowledged')`
    })
  }

  async resume(
    principal: AuthenticatedPrincipal,
    runId: string,
    input: { readonly idempotencyKey: string; readonly input?: Readonly<Record<string, unknown>> },
  ): Promise<RunStartResponse> {
    return this.#sql.begin(async (transaction) => {
      await requireDelegatableRun(transaction, principal, runId)
      await transaction`select pg_advisory_xact_lock(hashtextextended(${`${runId}:${input.idempotencyKey}`},0))`
      const replay = await transaction`select result from runtime_idempotency where run_id=${runId}
        and idempotency_key=${input.idempotencyKey} order by generation desc limit 1`
      if (replay[0] !== undefined) throw new RuntimeConflictError("idempotency_conflict")
      const rows =
        await transaction`select id,workspace_id,installation_id,subject_ref,directive_ref,
        state,generation,depth from runtime_runs where workspace_id=${principal.workspaceId}
        and id=${runId} for update`
      if (rows[0] === undefined) throw new RuntimeNotFoundError()
      const run = RunRowSchema.parse(rows[0])
      if (!new Set(["awaiting_input", "stale"]).has(run.state)) {
        throw new RuntimeConflictError("invalid_transition")
      }
      const token = issueRunToken()
      const generation = run.generation + 1
      const lease = await issueLease(transaction, run.id, generation, token)
      await transaction`update runtime_runs set state='preparing',generation=${generation},
        token_hash=${runTokenDigest(token)},token_expires_at=${lease.tokenExpiresAt},
        updated_at=clock_timestamp() where id=${run.id}`
      if (input.input !== undefined) {
        await transaction`insert into runtime_input_snapshots
          (run_id,generation,revision,body,digest) values (${run.id},${generation},1,
          ${transaction.json(toJsonValue(input.input))},encode(public.digest(convert_to(${JSON.stringify(input.input)},'utf8'),'sha256'),'hex'))`
      }
      const response = runStartResponse(
        {
          id: run.id,
          installationId: run.installation_id,
          subjectRef: run.subject_ref,
          directiveRef: run.directive_ref,
        },
        token,
        generation,
        lease.leaseExpiresAt,
      )
      await transaction`insert into runtime_idempotency
        (run_id,generation,idempotency_key,fingerprint,result) values
        (${run.id},${generation},${input.idempotencyKey},
         ${runtimeFingerprint(input)},${transaction.json({ runId: run.id, generation })})`
      return response
    })
  }
}

async function startInTransaction(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  input: StartRunInput,
): Promise<RunStartResponse> {
  await transaction`select pg_advisory_xact_lock(hashtextextended(
    ${`${principal.workspaceId}:${input.idempotencyKey}`},0))`
  const existing =
    await transaction`select id,workspace_id,installation_id,subject_ref,directive_ref,
    state,generation,depth,policy_snapshot->>'startToken' token from runtime_runs
    where workspace_id=${principal.workspaceId} and requester_id=${principal.principalId}
      and policy_snapshot->>'idempotencyKey'=${input.idempotencyKey}`
  if (existing[0] !== undefined) throw new RuntimeConflictError("idempotency_conflict")
  const rows =
    await transaction`select i.principal_id,i.definition_revision_id,i.runtime_endpoint_id,
      i.capabilities,i.scopes,i.permissions,e.heartbeat_seconds,e.supported_capabilities,
      d.required_capabilities,coalesce((select jsonb_agg(mp.permission order by mp.permission)
        from membership_permissions mp where mp.workspace_id=i.workspace_id
          and mp.principal_id=i.principal_id),'[]'::jsonb) current_permissions
    from agent_installations i
    join runtime_endpoints e on e.workspace_id=i.workspace_id and e.id=i.runtime_endpoint_id
    join agent_definition_revisions d on d.workspace_id=i.workspace_id and d.id=i.definition_revision_id
    where i.workspace_id=${principal.workspaceId} and i.id=${input.installationId}
      and i.enabled and i.delegatable and e.enabled for update of i,e`
  if (rows[0] === undefined) throw new RuntimeNotFoundError()
  const installation = InstallationRowSchema.parse(rows[0])
  await requireStartSubjectAccess(
    transaction,
    principal,
    input.subjectRef,
    installation.principal_id,
  )
  const endpointCapabilities = new Set(installation.supported_capabilities)
  const capabilities = installation.capabilities.filter((capability) =>
    endpointCapabilities.has(capability),
  )
  const allowed = new Set(capabilities)
  if (installation.required_capabilities.some((capability) => !allowed.has(capability))) {
    throw new RuntimeCapabilityError()
  }
  if (input.requestedCapabilities.some((capability) => !allowed.has(capability))) {
    throw new RuntimeCapabilityError()
  }
  const depth = await childDepth(transaction, principal.workspaceId, input.parentRunId)
  const runId = `run:${randomUUID()}`
  const sessionId = `session:${randomUUID()}`
  const token = issueRunToken()
  const selectedCapabilities =
    input.requestedCapabilities.length === 0 ? capabilities : input.requestedCapabilities
  const currentPermissions = new Set(installation.current_permissions)
  const policy = {
    definitionRevisionId: installation.definition_revision_id,
    runtimeEndpointId: installation.runtime_endpoint_id,
    capabilities: selectedCapabilities,
    scopes: installation.scopes,
    permissions: installation.permissions.filter((permission) =>
      currentPermissions.has(permission),
    ),
    idempotencyKey: input.idempotencyKey,
  }
  await transaction`insert into runtime_sessions
    (id,workspace_id,installation_id,subject_ref,directive_ref,requester_id) values
    (${sessionId},${principal.workspaceId},${input.installationId},${input.subjectRef},
     ${input.directiveRef},${principal.principalId})`
  const lease = await issueLease(transaction, runId, 1, token, false)
  await transaction`insert into runtime_runs
    (id,workspace_id,session_id,installation_id,parent_run_id,depth,state,generation,
     subject_ref,directive_ref,requester_id,policy_snapshot,token_hash,token_expires_at)
    values (${runId},${principal.workspaceId},${sessionId},${input.installationId},
      ${input.parentRunId},${depth},'preparing',1,${input.subjectRef},${input.directiveRef},
      ${principal.principalId},${transaction.json(policy)},${runTokenDigest(token)},${lease.tokenExpiresAt})`
  await transaction`insert into runtime_leases
    (run_id,generation,owner,status,expires_at,heartbeat_deadline) values
    (${runId},1,${installation.principal_id},'issued',${lease.leaseExpiresAt},${lease.heartbeatDeadline})`
  return runStartResponse(
    {
      id: runId,
      installationId: input.installationId,
      subjectRef: input.subjectRef,
      directiveRef: input.directiveRef,
    },
    token,
    1,
    lease.leaseExpiresAt,
  )
}

async function childDepth(
  transaction: TransactionSql,
  workspaceId: string,
  parent: string | null,
): Promise<number> {
  if (parent === null) return 0
  const rows = await transaction<{ readonly depth: number }[]>`select depth from runtime_runs
    where workspace_id=${workspaceId} and id=${parent} and state in ('preparing','running','awaiting_input') for update`
  const depth = rows[0]?.depth
  if (depth === undefined || depth >= 4) throw new RuntimeConflictError("child_run_bound_exceeded")
  return depth + 1
}

async function issueLease(
  transaction: TransactionSql,
  runId: string,
  generation: number,
  token: string,
  insert = true,
): Promise<{
  readonly leaseExpiresAt: string
  readonly heartbeatDeadline: string
  readonly tokenExpiresAt: string
}> {
  const rows = await transaction<
    {
      readonly lease_expires_at: string
      readonly heartbeat_deadline: string
      readonly token_expires_at: string
    }[]
  >`
    select to_char(clock_timestamp()+interval '2 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') lease_expires_at,
      to_char(clock_timestamp()+interval '45 seconds','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') heartbeat_deadline,
      to_char(clock_timestamp()+interval '15 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') token_expires_at`
  const row = rows[0]
  if (row === undefined) throw new RuntimeConflictError("clock_unavailable")
  if (insert) {
    const owner = createHash("sha256").update(token).digest("hex")
    await transaction`insert into runtime_leases
      (run_id,generation,owner,status,expires_at,heartbeat_deadline) values
      (${runId},${generation},${owner},'issued',${row.lease_expires_at},${row.heartbeat_deadline})`
  }
  return {
    leaseExpiresAt: row.lease_expires_at,
    heartbeatDeadline: row.heartbeat_deadline,
    tokenExpiresAt: row.token_expires_at,
  }
}
