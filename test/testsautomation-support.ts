import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"
import { processGitHubDeliveries } from "../src/automation/github-worker.ts"
import type { HttpsTransport } from "../src/automation/outgoing-worker.ts"
import { automationEntityId } from "../src/automation/persistence.ts"
import { createGitHubWebhookRoute } from "../src/http/automation/index.ts"

export type AutomationApi = (
  path: string,
  method: string,
  payload?: unknown,
  baseRevision?: number | null,
  key?: string,
) => Promise<Response>

export function createAutomationApi(origin: string, token: string): AutomationApi {
  return (path, method, payload, baseRevision = null, key = crypto.randomUUID()) =>
    request(
      origin,
      path,
      token,
      method,
      payload === undefined
        ? undefined
        : { commandId: crypto.randomUUID(), idempotencyKey: key, baseRevision, payload },
    )
}

export async function seedAutomationTemplate(sql: Sql): Promise<string> {
  const id = automationEntityId("planning-template", "r8-workspace", "fixture")
  await sql.begin(async (transaction) => {
    await transaction`insert into entities(id,workspace_id,kind,current_revision,created_by,created_at,updated_at) values (${id},'r8-workspace','planning_template',1,'owner',clock_timestamp(),clock_timestamp())`
    await transaction`insert into entity_acl_policies values (${id},'inherit')`
    await transaction`insert into planning_templates(id,workspace_id,name,kind,current_revision,created_by,created_at,updated_at) values (${id},'r8-workspace','Fixture','work',1,'owner',clock_timestamp(),clock_timestamp())`
    await transaction`insert into planning_template_revisions(template_id,revision,content,actor_id,created_at) values (${id},1,'{}','owner',clock_timestamp())`
  })
  return id
}

export async function assertAutomationTrigger(sql: Sql): Promise<void> {
  const rows = await sql<
    { readonly event_type: string }[]
  >`select trigger_spec->>'eventType' event_type from automation_rules`
  assert.equal(rows[0]?.event_type, "entity.created", JSON.stringify(rows))
}

export async function proveGitHubWebhook(sql: Sql, secret: string): Promise<void> {
  const installationId = automationEntityId("github", "r8-workspace", "42")
  const route = createGitHubWebhookRoute(sql)
  const server = createServer((request, response) => void route(request, response))
  const origin = await listen(server)
  const body = JSON.stringify({ action: "opened", issue: { number: 7, title: "GitHub title" } })
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
  const send = () =>
    fetch(`${origin}/api/automation/v1/github/webhooks/${encodeURIComponent(installationId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-1",
        "x-github-event": "issues",
        "x-hub-signature-256": signature,
      },
      body,
    })
  const invalid = await fetch(
    `${origin}/api/automation/v1/github/webhooks/${encodeURIComponent(installationId)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "invalid",
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      },
      body,
    },
  )
  assert.equal(invalid.status, 401)
  assert.equal(
    (await sendGitHubWebhook(origin, installationId, secret, "malformed", "{")).status,
    400,
  )
  assert.equal(
    (
      await sendGitHubWebhook(
        origin,
        installationId,
        secret,
        "oversized",
        `{"x":"${"x".repeat(1024 * 1024)}"}`,
      )
    ).status,
    413,
  )
  assert.equal((await send()).status, 202)
  assert.equal((await send()).status, 200)
  await close(server)
}

export async function mapGitHubIssue(
  api: AutomationApi,
  installationId: string,
  workId: string,
): Promise<void> {
  const response = await api("/api/automation/v1/workspaces/r8-workspace/github/mappings", "POST", {
    installationId,
    githubNumber: 7,
    entityId: workId,
  })
  assert.equal(response.status, 201, await response.clone().text())
}

export async function proveGitHubConsumed(
  sql: Sql,
  installationId: string,
  workId: string,
): Promise<void> {
  assert.equal(await processGitHubDeliveries(sql, new Date("2100-01-01T00:00:00.000Z"), 100), 1)
  const rows = await sql<
    { readonly title: string; readonly state: string; readonly processed: boolean }[]
  >`select work.title,delivery.state,delivery.processed_at is not null processed
    from work_items work cross join github_webhook_deliveries delivery
    where work.id=${workId} and delivery.installation_id=${installationId}
      and delivery.delivery_id='delivery-1'`
  assert.deepEqual(rows[0], { title: "GitHub title", state: "succeeded", processed: true })
}

async function sendGitHubWebhook(
  origin: string,
  installationId: string,
  secret: string,
  delivery: string,
  body: string,
): Promise<Response> {
  return fetch(
    `${origin}/api/automation/v1/github/webhooks/${encodeURIComponent(installationId)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": delivery,
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    },
  )
}

export async function createCaptureTransport(): Promise<{
  readonly server: Server
  readonly received: unknown[]
  readonly transport: HttpsTransport
}> {
  const received: unknown[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      received.push(JSON.parse(body))
      response.writeHead(204)
      response.end()
    })
  })
  const origin = await listen(server)
  return {
    server,
    received,
    transport: {
      async send(outgoing) {
        const response = await fetch(`${origin}/delivery`, {
          method: outgoing.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(outgoing.body),
        })
        return response.status
      },
    },
  }
}

export function resultId(body: unknown): string {
  return z.object({ result: z.object({ id: z.string() }) }).parse(body).result.id
}

export function required(value: string | undefined): string {
  if (value === undefined) throw new Error("fixture value missing")
  return value
}

export function request(
  origin: string,
  path: string,
  token: string,
  method: string,
  body?: unknown,
) {
  return fetch(`${origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

export function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string")
        throw new Error("server address unavailable")
      resolve(`http://127.0.0.1:${address.port}`)
    }),
  )
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}
