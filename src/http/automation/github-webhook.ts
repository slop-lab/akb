import { createHmac, timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import { writeJson } from "../responses.ts"

const MAX_BODY_BYTES = 1024 * 1024
const HeadersSchema = z.strictObject({
  delivery: z.string().trim().min(1).max(500),
  event: z.string().trim().min(1).max(200),
  signature: z.string().regex(/^sha256=[0-9a-f]{64}$/),
})

export type RawWebhookRoute = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>

export function createGitHubWebhookRoute(sql: Sql): RawWebhookRoute {
  return async (request, response) => {
    if (request.method !== "POST") return false
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname
    const match = /^\/api\/automation\/v1\/github\/webhooks\/([^/]+)$/.exec(pathname)
    if (match === null) return false
    try {
      const installationId = decodeURIComponent(match[1] ?? "")
      const rows = await sql<{ readonly webhook_secret: Buffer }[]>`select webhook_secret
        from github_installations where id=${installationId}`
      const secret = rows[0]?.webhook_secret
      if (secret === undefined) return write(response, 404, "not_found")
      const raw = await readRaw(request)
      const parsed = HeadersSchema.safeParse({
        delivery: singleHeader(request, "x-github-delivery"),
        event: singleHeader(request, "x-github-event"),
        signature: singleHeader(request, "x-hub-signature-256"),
      })
      if (!parsed.success || !validSignature(secret, raw, parsed.data.signature))
        return write(response, 401, "invalid_signature")
      const payload = z.record(z.string(), z.unknown()).parse(JSON.parse(raw.toString("utf8")))
      const inserted = await sql`insert into github_webhook_deliveries
        (installation_id,delivery_id,event_name,payload,received_at)
        values (${installationId},${parsed.data.delivery},${parsed.data.event},
          ${JSON.stringify(payload)}::text::jsonb,clock_timestamp()) on conflict do nothing returning delivery_id`
      if (inserted.length === 0) return write(response, 200, "replayed")
      writeJson(response, 202, { accepted: true })
      return true
    } catch (error) {
      if (error instanceof WebhookBodyTooLargeError)
        return write(response, 413, "payload_too_large")
      if (error instanceof SyntaxError || error instanceof URIError || error instanceof z.ZodError)
        return write(response, 400, "invalid_payload")
      throw error
    }
  }
}

function validSignature(secret: Buffer, body: Buffer, header: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest()
  const supplied = Buffer.from(header.slice("sha256=".length), "hex")
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
}
function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? undefined : value
}
async function readRaw(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new WebhookBodyTooLargeError()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}
class WebhookBodyTooLargeError extends Error {
  override readonly name = "WebhookBodyTooLargeError"
}
function write(response: ServerResponse, status: number, code: string): true {
  writeJson(response, status, { error: { code, message: code, retryable: false, details: {} } })
  return true
}
