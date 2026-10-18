import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Sql } from "postgres"
import { z } from "zod"

export async function seedRuntimeEntities(sql: Sql): Promise<void> {
  const entities = [
    { id: "item-a", title: "Alpha" },
    { id: "item-b", title: "Beta" },
    { id: "item-c", title: "Gamma" },
    { id: "item-private", title: "Secret" },
  ] as const
  for (const { id, title } of entities) {
    await sql`insert into entities
      (id,workspace_id,kind,current_revision,created_by,created_at,updated_at)
      values (${id},'runtime-workspace','work_item',1,'runtime-owner',clock_timestamp(),clock_timestamp())`
    await sql`insert into entity_acl_policies values
      (${id},${id === "item-private" ? "restricted" : "inherit"})`
    await sql`insert into entity_revisions
      (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
      values (${id},1,'test.v1',${sql.json({ id, title })},'runtime-owner',clock_timestamp(),repeat('a',64))`
  }
}

export async function requestJson(
  origin: string,
  path: string,
  token: string,
  body?: unknown,
  method = "POST",
): Promise<Record<string, unknown>> {
  const response = await request(origin, path, token, body, method)
  const text = await response.text()
  assert.ok(response.ok, `${response.status}: ${text}`)
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text))
}

export function request(
  origin: string,
  path: string,
  token: string,
  body?: unknown,
  method = "POST",
) {
  return fetch(`${origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

export function responseItemIds(page: Record<string, unknown>): readonly string[] {
  return z
    .array(z.object({ id: z.string() }))
    .parse(page["items"])
    .map((item) => item.id)
}

export function retrievalRequest(cursor: string | null) {
  return {
    operation: "search_entities",
    query: "",
    ids: [],
    kinds: ["work_item"],
    projection: "card",
    budget: { maxItems: 1, maxTokens: 10000 },
    cursor,
  }
}

export function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string")
        throw new TypeError("server address unavailable")
      resolve(`http://127.0.0.1:${address.port}`)
    }),
  )
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

export class RuntimeHttpClient {
  readonly #humanOrigin: string
  readonly #runtimeOrigin: string
  readonly #humanToken: string

  constructor(humanOrigin: string, runtimeOrigin: string, humanToken: string) {
    this.#humanOrigin = humanOrigin
    this.#runtimeOrigin = runtimeOrigin
    this.#humanToken = humanToken
  }

  human(path: string, body: unknown): Promise<Record<string, unknown>> {
    return requestJson(
      this.#humanOrigin,
      `/api/runtime/v1/workspaces/runtime-workspace${path}`,
      this.#humanToken,
      body,
    )
  }

  humanGet(path: string): Promise<Record<string, unknown>> {
    return requestJson(
      this.#humanOrigin,
      `/api/runtime/v1/workspaces/runtime-workspace${path}`,
      this.#humanToken,
      undefined,
      "GET",
    )
  }

  humanResponse(path: string, body?: unknown, method = "POST") {
    return request(
      this.#humanOrigin,
      `/api/runtime/v1/workspaces/runtime-workspace${path}`,
      this.#humanToken,
      body,
      method,
    )
  }

  withHumanToken(token: string): RuntimeHttpClient {
    return new RuntimeHttpClient(this.#humanOrigin, this.#runtimeOrigin, token)
  }

  runtimeJson(runId: string, path: string, token: string, body?: unknown, method = "POST") {
    return requestJson(
      this.#runtimeOrigin,
      `/api/runtime/v1/runs/${encodeURIComponent(runId)}${path}`,
      token,
      body,
      method,
    )
  }

  runtime(runId: string, path: string, token: string, body?: unknown, method = "POST") {
    return request(
      this.#runtimeOrigin,
      `/api/runtime/v1/runs/${encodeURIComponent(runId)}${path}`,
      token,
      body,
      method,
    )
  }
}
