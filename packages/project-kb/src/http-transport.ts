import ky, { HTTPError } from "ky"
import { z } from "zod"
import type { ProjectKbTransport } from "./client.ts"

const ErrorSchema = z.object({ error: z.object({ code: z.string() }) })
export class ProjectKbHttpError extends Error {
  override readonly name = "ProjectKbHttpError"
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(
      status === 409
        ? "This document changed. Reload it before saving again."
        : `Project knowledge request failed (${status}).`,
    )
    this.status = status
    this.code = code
  }
}

export function createHttpTransport(options: {
  readonly baseUrl: string
  readonly token: () => string | Promise<string>
  readonly onUnauthorized?: () => void
}): ProjectKbTransport {
  const baseUrl = new URL(options.baseUrl)
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:")
    throw new TypeError("An HTTP(S) API origin is required")
  if (baseUrl.username !== "" || baseUrl.password !== "")
    throw new TypeError("Credentials must not be embedded in the API URL")
  const http = ky.create({ baseUrl: baseUrl.origin, retry: 0, timeout: 15_000, redirect: "error" })
  return async (request) => {
    try {
      return await http(request.path, {
        method: request.method,
        headers: { authorization: `Bearer ${await options.token()}` },
        ...(request.body === undefined ? {} : { json: request.body }),
      }).json<unknown>()
    } catch (error) {
      if (!(error instanceof HTTPError)) throw error
      if (error.response.status === 401) options.onUnauthorized?.()
      const parsed = ErrorSchema.safeParse(error.data)
      throw new ProjectKbHttpError(
        error.response.status,
        parsed.success ? parsed.data.error.code : "request_failed",
      )
    }
  }
}
