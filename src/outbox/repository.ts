import { randomUUID } from "node:crypto"
import type { Sql } from "postgres"
import { z } from "zod"
import { IdentityNotActiveError } from "../identity/admin-errors.ts"
import { retryDelaySeconds } from "./policy.ts"

const OutboxEventSchema = z.strictObject({
  job_id: z.string().uuid(),
  event_id: z.string(),
  workspace_id: z.string(),
  space_id: z.string().nullable(),
  destination_id: z.string(),
  sequence: z.coerce.number().int().positive(),
  event_type: z.enum(["work_item.created", "work_item.updated"]),
  occurred_at: z.date(),
  actor_id: z.string(),
  subject_id: z.string(),
  subject_revision: z.coerce.number().int().positive(),
  changed_fields: z.array(z.enum(["title", "state"])).nullable(),
  lease_owner: z.string().uuid(),
  lease_generation: z.coerce.number().int().positive(),
  attempts: z.number().int().positive(),
})

export type ClaimedDelivery = {
  readonly jobId: string
  readonly eventId: string
  readonly workspaceId: string
  readonly spaceId?: string
  readonly destinationId: string
  readonly sequence: number
  readonly eventType: "work_item.created" | "work_item.updated"
  readonly occurredAt: Date
  readonly actorId: string
  readonly subjectId: string
  readonly subjectRevision: number
  readonly changedFields: readonly ("title" | "state")[] | null
  readonly leaseOwner: string
  readonly leaseGeneration: number
  readonly attempts: number
}

export type DestinationScope = {
  readonly workspaceId: string
  readonly destinationId: string
}

export class OutboxRepository {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  async register(scope: DestinationScope): Promise<number> {
    return this.#sql.begin(async (transaction) => {
      const workspaces = await transaction`
        select id from workspaces where id = ${scope.workspaceId} and status = 'active' for update`
      if (workspaces.length !== 1) throw new IdentityNotActiveError()
      await transaction`select pg_advisory_xact_lock(hashtextextended(${scope.workspaceId}, 73491))`
      const rows = await transaction<{ readonly cutoff: string | number }[]>`
        select coalesce(max(sequence), 0) as cutoff from domain_events
        where workspace_id = ${scope.workspaceId}`
      const cutoff = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(rows[0]?.cutoff ?? 0)
      await transaction`insert into outbox_destinations
        (workspace_id, destination_id, sink, start_after_sequence)
        values (${scope.workspaceId}, ${scope.destinationId}, 'database-inbox', ${cutoff})`
      return cutoff
    })
  }

  async claim(scope: DestinationScope, leaseSeconds = 30): Promise<ClaimedDelivery | undefined> {
    const owner = randomUUID()
    return this.#sql.begin(async (transaction) => {
      await transaction`with selected as (
        select job_id from outbox_jobs where workspace_id = ${scope.workspaceId}
          and destination_id = ${scope.destinationId} and state <> 'delivered'
        order by sequence limit 1
      ), head as (
        select j.job_id from outbox_jobs j join selected s on s.job_id = j.job_id
        for update of j skip locked
      ) update outbox_jobs j set state = 'dead_letter', lease_owner = null,
        lease_expires_at = null, last_error = 'lease expired after maximum attempts'
        from head where j.job_id = head.job_id and j.state = 'leased'
          and j.lease_expires_at <= clock_timestamp() and j.attempts >= 5`
      const rows = await transaction`with selected as (
        select j.job_id from outbox_jobs j
        where j.workspace_id = ${scope.workspaceId}
          and j.destination_id = ${scope.destinationId} and j.state <> 'delivered'
        order by j.sequence limit 1
      ), candidate as (
        select j.job_id from outbox_jobs j join selected s on s.job_id = j.job_id
        where j.state in ('pending', 'leased') and j.attempts < 5
          and j.available_at <= clock_timestamp()
          and (j.state = 'pending' or j.lease_expires_at <= clock_timestamp())
        for update of j skip locked
      ) update outbox_jobs j set state = 'leased', lease_owner = ${owner},
        lease_generation = j.lease_generation + 1,
        lease_expires_at = clock_timestamp() + ${leaseSeconds} * interval '1 second',
        attempts = j.attempts + 1, last_error = null
      from candidate c, outbox_events e
      where j.job_id = c.job_id and e.workspace_id = j.workspace_id and e.event_id = j.event_id
      returning j.job_id, j.event_id, j.workspace_id, j.destination_id, j.sequence,
        e.event_type, e.occurred_at, e.actor_id, e.subject_id, e.subject_revision,
        e.space_id, e.changed_fields, j.lease_owner, j.lease_generation, j.attempts`
      const record = rows[0]
      if (record === undefined) return undefined
      const row = OutboxEventSchema.parse(record)
      return {
        jobId: row.job_id,
        eventId: row.event_id,
        workspaceId: row.workspace_id,
        ...(row.space_id === null ? {} : { spaceId: row.space_id }),
        destinationId: row.destination_id,
        sequence: row.sequence,
        eventType: row.event_type,
        occurredAt: row.occurred_at,
        actorId: row.actor_id,
        subjectId: row.subject_id,
        subjectRevision: row.subject_revision,
        changedFields: row.changed_fields,
        leaseOwner: row.lease_owner,
        leaseGeneration: row.lease_generation,
        attempts: row.attempts,
      }
    })
  }

  async deliverToInbox(delivery: ClaimedDelivery): Promise<void> {
    await this.#sql`insert into delivery_inbox
      (destination_id, event_id, workspace_id, space_id, sequence, event_type, occurred_at,
       actor_id, subject_id, subject_revision, changed_fields)
      values (${delivery.destinationId}, ${delivery.eventId}, ${delivery.workspaceId}, ${delivery.spaceId ?? null},
        ${delivery.sequence}, ${delivery.eventType}, ${delivery.occurredAt}, ${delivery.actorId},
        ${delivery.subjectId}, ${delivery.subjectRevision}, ${delivery.changedFields})
      on conflict (destination_id, event_id) do nothing`
  }

  async acknowledge(delivery: ClaimedDelivery): Promise<boolean> {
    const rows = await this
      .#sql`update outbox_jobs set state = 'delivered', delivered_at = clock_timestamp(),
      lease_owner = null, lease_expires_at = null where job_id = ${delivery.jobId}
      and lease_owner = ${delivery.leaseOwner} and lease_generation = ${delivery.leaseGeneration}
      and state = 'leased' and lease_expires_at > clock_timestamp() returning job_id`
    return rows.length === 1
  }

  async fail(delivery: ClaimedDelivery, error: string): Promise<boolean> {
    const dead = delivery.attempts >= 5
    const delay = retryDelaySeconds(delivery.attempts)
    const rows = await this.#sql`update outbox_jobs set state = ${dead ? "dead_letter" : "pending"},
      available_at = clock_timestamp() + ${delay} * interval '1 second',
      last_error = ${error.slice(0, 500)}, lease_owner = null, lease_expires_at = null
      where job_id = ${delivery.jobId} and lease_owner = ${delivery.leaseOwner}
        and lease_generation = ${delivery.leaseGeneration} and state = 'leased'
        and lease_expires_at > clock_timestamp() returning job_id`
    return rows.length === 1
  }

  async retryDead(scope: DestinationScope, jobId: string): Promise<boolean> {
    const rows = await this.#sql`update outbox_jobs set state = 'pending', attempts = 0,
      available_at = clock_timestamp(), last_error = null
      where workspace_id = ${scope.workspaceId} and destination_id = ${scope.destinationId}
        and job_id = ${jobId} and state = 'dead_letter' returning job_id`
    return rows.length === 1
  }
}
