import { createHash } from "node:crypto"
import type { TransactionSql } from "postgres"
import { z } from "zod"
import { RunTokenSchema } from "./credentials.ts"
import { RunNotActiveError } from "./errors.ts"

const RunPrincipalRowSchema = z.strictObject({
  workspace_id: z.string(),
  run_id: z.string(),
  installation_id: z.string(),
  principal_id: z.string(),
  generation: z.coerce.number().int().positive(),
  capabilities: z.array(z.string()),
})

export type RunPrincipal = {
  readonly workspaceId: string
  readonly runId: string
  readonly installationId: string
  readonly principalId: string
  readonly generation: number
  readonly tokenDigest: Buffer
  readonly capabilities: readonly string[]
}

export async function authenticateRunToken(
  transaction: TransactionSql,
  token: string,
): Promise<RunPrincipal | undefined> {
  const parsed = RunTokenSchema.safeParse(token)
  if (!parsed.success) return undefined
  const tokenDigest = createHash("sha256").update(parsed.data).digest()
  const rows = await transaction`select r.workspace_id,r.id run_id,r.installation_id,
      i.principal_id,r.generation,r.policy_snapshot->'capabilities' capabilities
    from runtime_runs r join workspaces w on w.id=r.workspace_id
    join agent_installations i on i.workspace_id=r.workspace_id and i.id=r.installation_id
    join runtime_endpoints e on e.workspace_id=i.workspace_id and e.id=i.runtime_endpoint_id
    join principals p on p.workspace_id=i.workspace_id and p.id=i.principal_id
    join workspace_memberships m on m.workspace_id=p.workspace_id and m.principal_id=p.id
    join runtime_leases l on l.run_id=r.id and l.generation=r.generation
    where r.token_hash=${tokenDigest} and r.token_expires_at>clock_timestamp()
      and w.status='active' and i.enabled and e.enabled and p.status='active' and m.status='active'
      and l.status in ('issued','acknowledged') and l.expires_at>clock_timestamp()`
  if (rows[0] === undefined) return undefined
  const row = RunPrincipalRowSchema.parse(rows[0])
  return {
    workspaceId: row.workspace_id,
    runId: row.run_id,
    installationId: row.installation_id,
    principalId: row.principal_id,
    generation: row.generation,
    tokenDigest,
    capabilities: row.capabilities,
  }
}

export async function requireLeaseAcknowledgementFence(
  transaction: TransactionSql,
  principal: RunPrincipal,
  generation: number,
): Promise<void> {
  const rows = await transaction<{ readonly allowed: boolean }[]>`
    select runtime_write_fence(${principal.runId},${generation},${principal.tokenDigest},
      ${null},'issued') allowed`
  if (rows[0]?.allowed !== true) throw new RunNotActiveError()
}

export async function requireRunFence(
  transaction: TransactionSql,
  principal: RunPrincipal,
  generation: number,
  capability: string,
): Promise<void> {
  const rows = await transaction<{ readonly allowed: boolean }[]>`
    select runtime_write_fence(${principal.runId},${generation},${principal.tokenDigest},${capability}) allowed`
  if (rows[0]?.allowed !== true) {
    throw new RunNotActiveError()
  }
}
