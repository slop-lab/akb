import assert from "node:assert/strict"
import type { Sql } from "postgres"
import { z } from "zod"
import { deliverOutgoing, type HttpsTransport } from "../src/automation/outgoing-worker.ts"

export async function proveOutgoingDeadLetter(sql: Sql, extensionId: string): Promise<void> {
  const failedId = await insertRequest(sql, extensionId, "dead-letter")
  await sql`update outgoing_https_requests set state='succeeded' where id<>${failedId}::uuid
    and state in ('pending','failed')`
  const keys: string[] = []
  for (let attempt = 1; attempt <= 5; attempt += 1)
    await deliverOutgoing(sql, new Date(`2026-10-17T12:0${attempt}:00.000Z`), 1, {
      async send(request) {
        keys.push(request.idempotency_key)
        return 503
      },
    })
  assert.equal(new Set(keys).size, 1, JSON.stringify(keys))
  const rows = await sql<{ readonly state: string }[]>`select state from outgoing_https_requests
    where id=${failedId}::uuid`
  assert.equal(rows[0]?.state, "dead_letter")
}

export async function proveOutgoingLease(sql: Sql, extensionId: string): Promise<void> {
  await insertRequest(sql, extensionId, "concurrent")
  const keys: string[] = []
  const transport: HttpsTransport = {
    async send(request) {
      keys.push(request.idempotency_key)
      return 204
    },
  }
  const results = await Promise.all([
    deliverOutgoing(sql, new Date("2026-10-17T13:00:00.000Z"), 1, transport),
    deliverOutgoing(sql, new Date("2026-10-17T13:00:00.000Z"), 1, transport),
  ])
  assert.deepEqual(results.toSorted(), [0, 1])
  assert.equal(keys.length, 1)
}

export async function proveDisabledExtensionDenied(sql: Sql, extensionId: string): Promise<void> {
  await sql`update extension_installations set enabled=false where id=${extensionId}`
  const id = await insertRequest(sql, extensionId, "disabled")
  let sends = 0
  assert.equal(
    await deliverOutgoing(sql, new Date("2026-10-17T14:00:00.000Z"), 1, {
      async send() {
        sends += 1
        return 204
      },
    }),
    1,
  )
  assert.equal(sends, 0)
  const rows = await sql<{ readonly state: string }[]>`select state from outgoing_https_requests
    where id=${id}::uuid`
  assert.equal(rows[0]?.state, "failed")
}

async function insertRequest(sql: Sql, extensionId: string, marker: string): Promise<string> {
  const rows = await sql<{ readonly id: string }[]>`insert into outgoing_https_requests
    (workspace_id,idempotency_key,endpoint_kind,endpoint_id,url,method,body,state,available_at,created_at)
    values ('r8-workspace',${`delivery:${marker}`},'extension',${extensionId},
      'https://fixture.example/actions','POST',jsonb_build_object('marker',${marker}::text),
      'pending','2026-10-17T12:00:00Z',clock_timestamp()) returning id::text`
  return z.object({ id: z.string().uuid() }).parse(rows[0]).id
}
