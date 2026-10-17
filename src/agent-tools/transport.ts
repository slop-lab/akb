import { isJson } from "@slop-lab/part/contracts/index.js"
import type { Contracts } from "@slop-lab/part/reference/index.js"
import ky, { HTTPError, type KyInstance, ResponseSizeError, TimeoutError } from "ky"
import { z } from "zod"
import { WorkspaceToolConfigurationError, WorkspaceToolHttpError } from "./errors.ts"

const ApiErrorSchema = z.strictObject({
  error: z.object({ code: z.string() }).passthrough(),
})

export type WorkspaceTransport = {
  readonly request: (request: WorkspaceRequest) => Promise<Contracts.Json>
  readonly release: (snapshotId: string, signal?: AbortSignal) => Promise<void>
}

export type WorkspaceRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT"
  readonly path: string
  readonly body?: Contracts.Json
  readonly signal: AbortSignal
}

export function createWorkspaceTransport(options: {
  readonly origin: string
  readonly workspaceId: string
  readonly token: () => string | Promise<string>
  readonly timeoutMs: number
  readonly maxResponseBytes: number
}): WorkspaceTransport {
  const origin = parseOrigin(options.origin)
  const workspace = encodeURIComponent(z.string().trim().min(1).max(200).parse(options.workspaceId))
  const client = ky.create({
    baseUrl: `${origin}/`,
    retry: 0,
    timeout: options.timeoutMs,
    totalTimeout: options.timeoutMs,
    maxResponseSize: options.maxResponseBytes,
    redirect: "error",
  })
  const send = async (request: WorkspaceRequest): Promise<Contracts.Json> => {
    const response = await authorized(client, options.token, {
      ...request,
      path: request.path.replace(":workspaceId", workspace),
    })
    const value: unknown = await response.json()
    if (!isJson(value)) throw new WorkspaceToolHttpError(502, "invalid_response")
    return value
  }
  return {
    request: async (request) => safeRequest(() => send(request)),
    release: async (snapshotId, signal) => {
      await safeRequest(async () => {
        const token = await credential(options.token)
        await client.delete(
          `api/human/v1/workspaces/${workspace}/query-snapshots/${encodeURIComponent(snapshotId)}`,
          {
            headers: { authorization: `Bearer ${token}` },
            redirect: "error",
            ...(signal ? { signal } : {}),
          },
        )
        return null
      })
    },
  }
}

async function authorized(
  client: KyInstance,
  token: () => string | Promise<string>,
  request: WorkspaceRequest,
): Promise<Response> {
  const credentialValue = await credential(token)
  return client(`api/${request.path}`, {
    method: request.method,
    headers: { authorization: `Bearer ${credentialValue}` },
    redirect: "error",
    signal: request.signal,
    ...(request.body === undefined ? {} : { json: request.body }),
  })
}

async function credential(token: () => string | Promise<string>): Promise<string> {
  const value = await token()
  if (value.trim().length === 0) throw new WorkspaceToolConfigurationError("Token is empty")
  return value
}

async function safeRequest<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof HTTPError) {
      const parsed = ApiErrorSchema.safeParse(error.data)
      throw new WorkspaceToolHttpError(
        error.response.status,
        parsed.success ? parsed.data.error.code : "request_failed",
      )
    }
    if (error instanceof TimeoutError) throw new WorkspaceToolHttpError(0, "request_timeout")
    if (error instanceof ResponseSizeError)
      throw new WorkspaceToolHttpError(0, "response_too_large")
    if (error instanceof DOMException && error.name === "AbortError")
      throw new WorkspaceToolHttpError(0, "request_cancelled")
    throw error
  }
}

function parseOrigin(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    if (error instanceof TypeError) throw new WorkspaceToolConfigurationError("Invalid API origin")
    throw error
  }
  const loopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]"
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    throw new WorkspaceToolConfigurationError(
      "API origin must be an HTTPS origin or loopback HTTP origin",
    )
  return parsed.origin
}
