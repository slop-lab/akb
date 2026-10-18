import { createHash } from "node:crypto"
import type { Sql, TransactionSql } from "postgres"
import type { z } from "zod"
import { z as schema } from "zod"
import type {
  ActivityInputSchema,
  ArtifactChunkInputSchema,
  PlanStepInputSchema,
} from "../contracts/runtime/index.ts"
import { RunNotActiveError, RuntimeConflictError } from "./errors.ts"
import { toJsonValue } from "./json.ts"
import type { RunPrincipal } from "./principal.ts"
import { requireLeaseAcknowledgementFence, requireRunFence } from "./principal.ts"

type ActivityInput = z.infer<typeof ActivityInputSchema>
type PlanStepInput = z.infer<typeof PlanStepInputSchema>
type ArtifactChunkInput = z.infer<typeof ArtifactChunkInputSchema>
const IdempotencyRowSchema = schema.strictObject({
  fingerprint: schema.string(),
  result: schema.unknown(),
})

export class RuntimeWrites {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  async acknowledge(principal: RunPrincipal, generation: number): Promise<void> {
    await this.#sql.begin(async (transaction) => {
      await requireLeaseAcknowledgementFence(transaction, principal, generation)
      await transaction`update runtime_leases set status='acknowledged',
        acknowledged_at=clock_timestamp(),last_heartbeat_at=clock_timestamp()
        where run_id=${principal.runId} and generation=${generation}`
      await transaction`update runtime_runs set state='running',updated_at=clock_timestamp()
        where id=${principal.runId}`
    })
  }

  async heartbeat(principal: RunPrincipal, generation: number): Promise<void> {
    await this.#sql.begin(async (transaction) => {
      await requireRunFence(transaction, principal, generation, "activity.write")
      const rows = await transaction<{ readonly heartbeat_seconds: number }[]>`
        select e.heartbeat_seconds from runtime_runs r join agent_installations i
          on i.workspace_id=r.workspace_id and i.id=r.installation_id
        join runtime_endpoints e on e.workspace_id=i.workspace_id and e.id=i.runtime_endpoint_id
        where r.id=${principal.runId}`
      const seconds = rows[0]?.heartbeat_seconds
      if (seconds === undefined) throw new RunNotActiveError()
      await transaction`update runtime_leases set last_heartbeat_at=clock_timestamp(),
        heartbeat_deadline=clock_timestamp()+(${seconds}::text || ' seconds')::interval
        where run_id=${principal.runId} and generation=${generation}`
    })
  }

  async activity(principal: RunPrincipal, input: ActivityInput): Promise<unknown> {
    return this.#sql.begin(async (transaction) => {
      await requireRunFence(transaction, principal, input.generation, "activity.write")
      const fingerprint = digest(input)
      const replay = await idempotentReplay(
        transaction,
        principal,
        input.idempotencyKey,
        fingerprint,
      )
      if (replay !== undefined) return replay
      const sequenceRows = await transaction<{ readonly sequence: number }[]>`
        select coalesce(max(sequence),0)::integer+1 sequence from runtime_activity
        where run_id=${principal.runId}`
      const sequence = sequenceRows[0]?.sequence
      if (sequence === undefined) throw new RunNotActiveError()
      const result = { sequence }
      await transaction`insert into runtime_activity
        (run_id,generation,sequence,kind,actor_id,durable,body,references_json,raw_trace_refs,idempotency_key)
        values (${principal.runId},${input.generation},${sequence},${input.kind},${principal.principalId},
          ${input.durable},${transaction.json(toJsonValue(input.body))},${transaction.json(input.references)},
          ${transaction.json(input.rawTraceRefs)},${input.idempotencyKey})`
      if (input.kind === "question") {
        await transaction`update runtime_runs set state='awaiting_input',updated_at=clock_timestamp()
          where id=${principal.runId}`
      }
      await storeReplay(transaction, principal, input.idempotencyKey, fingerprint, result)
      return result
    })
  }

  async plan(principal: RunPrincipal, input: PlanStepInput): Promise<unknown> {
    return this.#sql.begin(async (transaction) => {
      await requireRunFence(transaction, principal, input.generation, "plan.write")
      const fingerprint = digest(input)
      const replay = await idempotentReplay(
        transaction,
        principal,
        input.idempotencyKey,
        fingerprint,
      )
      if (replay !== undefined) return replay
      const rows = await transaction<{ readonly revision: number }[]>`select revision::integer
        from runtime_plan_steps where run_id=${principal.runId} and step_id=${input.stepId} for update`
      const current = rows[0]?.revision ?? 0
      if (current !== input.baseRevision) throw new RuntimeConflictError("revision_conflict")
      const revision = current + 1
      await transaction`insert into runtime_plan_steps
        (run_id,step_id,parent_step_id,title,status,depends_on,result_refs,revision) values
        (${principal.runId},${input.stepId},${input.parentStepId},${input.title},${input.status},
         ${transaction.json(input.dependsOn)},${transaction.json(input.resultRefs)},${revision})
        on conflict (run_id,step_id) do update set parent_step_id=excluded.parent_step_id,
          title=excluded.title,status=excluded.status,depends_on=excluded.depends_on,
          result_refs=excluded.result_refs,revision=excluded.revision,updated_at=clock_timestamp()`
      const result = { stepId: input.stepId, revision }
      await storeReplay(transaction, principal, input.idempotencyKey, fingerprint, result)
      return result
    })
  }

  async artifact(principal: RunPrincipal, input: ArtifactChunkInput): Promise<unknown> {
    return this.#sql.begin(async (transaction) => {
      await requireRunFence(transaction, principal, input.generation, "artifact.write")
      const fingerprint = digest(input)
      const replay = await idempotentReplay(
        transaction,
        principal,
        input.idempotencyKey,
        fingerprint,
      )
      if (replay !== undefined) return replay
      const bytes = Buffer.from(input.bytes, "base64")
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > 262_144 ||
        digestBytes(bytes) !== input.digest
      ) {
        throw new RuntimeConflictError("artifact_digest_invalid")
      }
      if (input.chunkIndex === 0) {
        await transaction`insert into runtime_artifacts
          (id,workspace_id,run_id,kind,media_type,retention_class) values
          (${input.artifactId},${principal.workspaceId},${principal.runId},${input.kind},
           ${input.mediaType},${input.retentionClass})`
      }
      const artifact =
        await transaction`select id from runtime_artifacts where id=${input.artifactId}
        and workspace_id=${principal.workspaceId} and run_id=${principal.runId} and not complete for update`
      if (artifact.length !== 1) throw new RuntimeConflictError("artifact_not_writable")
      const previous = await transaction<
        { readonly count: number }[]
      >`select count(*)::integer count
        from runtime_artifact_chunks where artifact_id=${input.artifactId}`
      if (previous[0]?.count !== input.chunkIndex)
        throw new RuntimeConflictError("artifact_chunk_order")
      await transaction`insert into runtime_artifact_chunks (artifact_id,chunk_index,bytes,digest)
        values (${input.artifactId},${input.chunkIndex},${bytes},${input.digest})`
      await transaction`update runtime_artifacts set byte_size=byte_size+${bytes.byteLength},
        complete=${input.final},digest=case when ${input.final} then
          encode(public.digest(convert_to((select string_agg(digest,'' order by chunk_index)
            from runtime_artifact_chunks where artifact_id=${input.artifactId}),'utf8'),'sha256'),'hex')
          else null end where id=${input.artifactId}`
      const result = {
        artifactId: input.artifactId,
        chunkIndex: input.chunkIndex,
        complete: input.final,
      }
      await storeReplay(transaction, principal, input.idempotencyKey, fingerprint, result)
      return result
    })
  }
}

async function idempotentReplay(
  transaction: TransactionSql,
  principal: RunPrincipal,
  key: string,
  fingerprint: string,
): Promise<unknown | undefined> {
  const rows = await transaction`select fingerprint,result from runtime_idempotency
    where run_id=${principal.runId} and generation=${principal.generation}
      and idempotency_key=${key} for update`
  const row = rows[0]
  if (row === undefined) return undefined
  const parsed = IdempotencyRowSchema.parse(row)
  if (parsed.fingerprint !== fingerprint) throw new RuntimeConflictError("idempotency_conflict")
  return parsed.result
}

async function storeReplay(
  transaction: TransactionSql,
  principal: RunPrincipal,
  key: string,
  fingerprint: string,
  result: Readonly<Record<string, unknown>>,
): Promise<void> {
  await transaction`insert into runtime_idempotency
    (run_id,generation,idempotency_key,fingerprint,result) values
    (${principal.runId},${principal.generation},${key},${fingerprint},${transaction.json(toJsonValue(result))})`
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function digestBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
