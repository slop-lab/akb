import { randomUUID } from "node:crypto"
import type { Sql } from "postgres"
import { z } from "zod"
import { type EntityEvent, parseEntityEvent } from "../events/entity-event.ts"
import { IdentityNotActiveError } from "../identity/admin-errors.ts"
import { retryDelaySeconds } from "./policy.ts"
import type { DestinationScope } from "./repository.ts"

const ClaimRowSchema = z.strictObject({
  job_id: z.string().uuid(),
  destination_id: z.string(),
  lease_owner: z.string().uuid(),
  lease_generation: z.coerce.number().int().positive(),
  attempts: z.number().int().positive(),
  event: z.unknown(),
})

export type EntityClaimedDelivery = {
  readonly jobId: string
  readonly destinationId: string
  readonly leaseOwner: string
  readonly leaseGeneration: number
  readonly attempts: number
  readonly sequence: number
  readonly event: EntityEvent
}

export class EntityOutboxRepository {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  async register(scope: DestinationScope): Promise<number> {
    return this.#sql.begin(async (transaction) => {
      const workspaces = await transaction`select id from workspaces
        where id=${scope.workspaceId} and status='active' for update`
      if (workspaces.length !== 1) throw new IdentityNotActiveError()
      const rows = await transaction<{ readonly cutoff: string | number }[]>`
        select coalesce(max(sequence),0) cutoff from entity_events_v1
        where workspace_id=${scope.workspaceId}`
      const cutoff = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(rows[0]?.cutoff ?? 0)
      await transaction`insert into entity_outbox_destinations_v1
        (workspace_id,destination_id,sink,start_after_sequence)
        values (${scope.workspaceId},${scope.destinationId},'database-inbox',${cutoff})`
      return cutoff
    })
  }

  async claim(
    scope: DestinationScope,
    leaseSeconds = 30,
  ): Promise<EntityClaimedDelivery | undefined> {
    const owner = randomUUID()
    return this.#sql.begin(async (transaction) => {
      await transaction`with selected as (
        select job_id from entity_outbox_jobs_v1 where workspace_id=${scope.workspaceId}
          and destination_id=${scope.destinationId} and state<>'delivered'
        order by sequence limit 1
      ), head as (
        select j.job_id from entity_outbox_jobs_v1 j join selected s on s.job_id=j.job_id
        for update of j skip locked
      ) update entity_outbox_jobs_v1 j set state='dead_letter',lease_owner=null,
        lease_expires_at=null,last_error='lease expired after maximum attempts'
        from head where j.job_id=head.job_id and j.state='leased'
          and j.lease_expires_at<=clock_timestamp() and j.attempts>=5`
      const rows = await transaction`with selected as (
        select job_id from entity_outbox_jobs_v1 where workspace_id=${scope.workspaceId}
          and destination_id=${scope.destinationId} and state<>'delivered'
        order by sequence limit 1
      ), candidate as (
        select j.job_id from entity_outbox_jobs_v1 j join selected s on s.job_id=j.job_id
        where j.state in ('pending','leased') and j.attempts<5
          and j.available_at<=clock_timestamp()
          and (j.state='pending' or j.lease_expires_at<=clock_timestamp())
        for update of j skip locked
      ) update entity_outbox_jobs_v1 j set state='leased',lease_owner=${owner},
        lease_generation=j.lease_generation+1,
        lease_expires_at=clock_timestamp()+${leaseSeconds}*interval '1 second',
        attempts=j.attempts+1,last_error=null
      from candidate c,entity_outbox_events_v1 o where j.job_id=c.job_id
        and o.workspace_id=j.workspace_id and o.event_id=j.event_id
      returning j.job_id,j.destination_id,j.lease_owner,j.lease_generation,j.attempts,
        o.payload event`
      if (rows[0] === undefined) return undefined
      const row = ClaimRowSchema.parse(rows[0])
      const event = parseEntityEvent(row.event)
      return {
        jobId: row.job_id,
        destinationId: row.destination_id,
        leaseOwner: row.lease_owner,
        leaseGeneration: row.lease_generation,
        attempts: row.attempts,
        sequence: event.sequence,
        event,
      }
    })
  }

  async deliverToInbox(delivery: EntityClaimedDelivery): Promise<void> {
    await this.#sql`insert into delivery_inbox_v1
      (destination_id,event_id,workspace_id,sequence,payload)
      values (${delivery.destinationId},${delivery.event.id},${delivery.event.workspaceId},
        ${delivery.event.sequence},${this.#sql.json(delivery.event)})
      on conflict (destination_id,event_id) do nothing`
  }

  async acknowledge(delivery: EntityClaimedDelivery): Promise<boolean> {
    const rows = await this.#sql`update entity_outbox_jobs_v1 set state='delivered',
      delivered_at=clock_timestamp(),lease_owner=null,lease_expires_at=null
      where job_id=${delivery.jobId} and lease_owner=${delivery.leaseOwner}
        and lease_generation=${delivery.leaseGeneration} and state='leased'
        and lease_expires_at>clock_timestamp() returning job_id`
    return rows.length === 1
  }

  async fail(delivery: EntityClaimedDelivery, error: string): Promise<boolean> {
    const dead = delivery.attempts >= 5
    const delay = retryDelaySeconds(delivery.attempts)
    const rows = await this.#sql`update entity_outbox_jobs_v1
      set state=${dead ? "dead_letter" : "pending"},
        available_at=clock_timestamp()+${delay}*interval '1 second',
        last_error=${error.slice(0, 500)},lease_owner=null,lease_expires_at=null
      where job_id=${delivery.jobId} and lease_owner=${delivery.leaseOwner}
        and lease_generation=${delivery.leaseGeneration} and state='leased'
        and lease_expires_at>clock_timestamp() returning job_id`
    return rows.length === 1
  }

  async retryDead(scope: DestinationScope, jobId: string): Promise<boolean> {
    const rows = await this.#sql`update entity_outbox_jobs_v1 set state='pending',attempts=0,
      available_at=clock_timestamp(),last_error=null where workspace_id=${scope.workspaceId}
      and destination_id=${scope.destinationId} and job_id=${jobId}
      and state='dead_letter' returning job_id`
    return rows.length === 1
  }
}
