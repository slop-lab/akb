import type { IncomingMessage } from "node:http"
import { isRequestAborted } from "./request-state.ts"

export const MAX_JSON_BODY_BYTES = 64 * 1024

export type JsonBodyResult =
  | { readonly kind: "parsed"; readonly value: unknown }
  | { readonly kind: "invalid" }
  | { readonly kind: "too_large"; readonly limit: number }
  | { readonly kind: "aborted" }

export async function readJson(request: IncomingMessage): Promise<JsonBodyResult> {
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > MAX_JSON_BODY_BYTES) {
        request.resume()
        return { kind: "too_large", limit: MAX_JSON_BODY_BYTES }
      }
      chunks.push(chunk)
    }
  } catch (error) {
    if (isRequestAborted(request)) return { kind: "aborted" }
    throw error
  }
  if (isRequestAborted(request)) return { kind: "aborted" }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"))
    return { kind: "parsed", value }
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: "invalid" }
    throw error
  }
}
