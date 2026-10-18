import { randomUUID } from "node:crypto"
import { lookup } from "node:dns/promises"
import { request as httpsRequest } from "node:https"
import { BlockList, isIP } from "node:net"
import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"

const JobSchema = z.strictObject({
  id: z.string(),
  idempotency_key: z.string(),
  endpoint_kind: z.enum(["github", "extension", "webhook"]),
  endpoint_id: z.string(),
  url: z.string().url(),
  method: z.enum(["POST", "PATCH"]),
  body: z.record(z.string(), z.unknown()),
  headers: z.record(z.string(), z.string()),
  attempts: z.number().int().positive(),
  lease_generation: z.coerce.number().int().positive(),
  lease_owner: z.string().uuid(),
})
export type OutgoingRequest = z.infer<typeof JobSchema>
export interface HttpsTransport {
  send(request: OutgoingRequest): Promise<number>
}
export type DnsResolver = (hostname: string) => Promise<readonly DnsAddress[]>
export type DnsAddress = { readonly address: string; readonly family: 4 | 6 }

const deniedAddresses = new BlockList()
for (const [address, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 3, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
] as const) {
  deniedAddresses.addSubnet(address, prefix, family)
}

const systemResolver: DnsResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.map(({ address, family }) => {
    if (family !== 4 && family !== 6) throw new OutgoingDeliveryError("unsupported DNS family")
    return { address, family }
  })
}

export function createPinnedHttpsTransport(resolver: DnsResolver = systemResolver): HttpsTransport {
  return {
    async send(outgoing) {
      const url = new URL(outgoing.url)
      const addresses = await resolver(url.hostname)
      if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address)))
        throw new OutgoingDeliveryError("outgoing host resolves to a non-public address")
      const selected = addresses[0]
      if (selected === undefined) throw new OutgoingDeliveryError("outgoing host has no address")
      const body = JSON.stringify(outgoing.body)
      return new Promise((resolve, reject) => {
        const request = httpsRequest(
          {
            protocol: "https:",
            hostname: selected.address,
            port: url.port === "" ? 443 : Number(url.port),
            path: `${url.pathname}${url.search}`,
            method: outgoing.method,
            servername: url.hostname,
            headers: {
              ...outgoing.headers,
              host: url.host,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              "idempotency-key": outgoing.idempotency_key,
            },
            timeout: 10_000,
          },
          (response) => {
            response.resume()
            resolve(response.statusCode ?? 500)
          },
        )
        request.once("timeout", () => request.destroy(new Error("outgoing request timed out")))
        request.once("error", reject)
        request.end(body)
      })
    },
  }
}

export function isPublicAddress(address: string): boolean {
  const mapped = mappedIpv4(address)
  if (mapped !== null) return isPublicAddress(mapped)
  const family = isIP(address)
  return family !== 0 && !deniedAddresses.check(address, family === 4 ? "ipv4" : "ipv6")
}

function mappedIpv4(address: string): string | null {
  const suffix = /^::ffff:(.+)$/i.exec(address)?.[1]
  if (suffix === undefined) return null
  if (isIP(suffix) === 4) return suffix
  const words = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(suffix)
  if (words === null) return null
  const high = Number.parseInt(words[1] ?? "", 16)
  const low = Number.parseInt(words[2] ?? "", 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

export async function deliverOutgoing(
  sql: Sql,
  now: Date,
  limit: number,
  transport: HttpsTransport = createPinnedHttpsTransport(),
): Promise<number> {
  const owner = randomUUID()
  const jobs = await claim(sql, now, limit, owner)
  for (const job of jobs) {
    try {
      await requireAllowedDestination(sql, job)
      const status = await transport.send(job)
      if (status < 200 || status >= 300) throw new OutgoingDeliveryError(`HTTP ${status}`)
      await sql`update outgoing_https_requests set state='succeeded',last_error=null,
        lease_owner=null,lease_expires_at=null where id=${job.id}::uuid and state='delivering'
        and lease_owner=${job.lease_owner}::uuid and lease_generation=${job.lease_generation}`
    } catch (error) {
      const message = error instanceof Error ? error.message : "outgoing delivery failed"
      await sql`update outgoing_https_requests
        set state=${job.attempts >= 5 ? "dead_letter" : "failed"},last_error=${message},
          available_at=${new Date(now.getTime() + 2 ** job.attempts * 1_000).toISOString()},
          lease_owner=null,lease_expires_at=null where id=${job.id}::uuid and state='delivering'
          and lease_owner=${job.lease_owner}::uuid and lease_generation=${job.lease_generation}`
    }
  }
  return jobs.length
}

async function claim(
  sql: Sql,
  now: Date,
  limit: number,
  owner: string,
): Promise<OutgoingRequest[]> {
  return sql.begin(async (transaction) => {
    const rows = await transaction`select id::text from outgoing_https_requests
      where ((state in ('pending','failed') and available_at<=${now.toISOString()})
        or (state='delivering' and lease_expires_at<=${now.toISOString()}))
      order by available_at,id for update skip locked limit ${limit}`
    const claimed: OutgoingRequest[] = []
    for (const row of rows) {
      const id = z.object({ id: z.string() }).parse(row).id
      const jobs = await transaction`update outgoing_https_requests set state='delivering',
        attempts=attempts+1,lease_owner=${owner}::uuid,lease_generation=lease_generation+1,
        lease_expires_at=${new Date(now.getTime() + 30_000).toISOString()}
        where id=${id}::uuid returning id::text,idempotency_key,endpoint_kind,endpoint_id,url,method,
          body,headers,attempts,lease_generation,lease_owner::text`
      const job = JobSchema.parse(jobs[0])
      claimed.push(job)
    }
    return claimed
  })
}

async function requireAllowedDestination(
  sql: Sql | TransactionSql,
  job: OutgoingRequest,
): Promise<void> {
  const url = new URL(job.url)
  if (url.protocol !== "https:") throw new OutgoingDeliveryError("outgoing URL must use HTTPS")
  if (job.endpoint_kind === "extension") {
    const rows = await sql<
      { readonly endpoint_url: string }[]
    >`select endpoint_url from extension_installations where id=${job.endpoint_id} and enabled`
    if (rows[0]?.endpoint_url !== job.url)
      throw new OutgoingDeliveryError("extension endpoint is not approved")
    return
  }
  if (job.endpoint_kind === "github") {
    const rows = await sql<
      { readonly allowed: boolean }[]
    >`select ${url.hostname}=any(allowed_hosts) allowed from github_installations where id=${job.endpoint_id}`
    if (rows[0]?.allowed !== true) throw new OutgoingDeliveryError("GitHub host is not allowed")
    return
  }
  throw new OutgoingDeliveryError("unregistered webhook endpoint")
}

export class OutgoingDeliveryError extends Error {
  override readonly name = "OutgoingDeliveryError"
}
