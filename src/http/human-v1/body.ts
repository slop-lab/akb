import type { IncomingMessage } from "node:http"

export class RequestBodyError extends Error {
  override readonly name = "RequestBodyError"
}

export async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > limit) throw new RequestBodyError("request body exceeds limit")
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

export async function readJson(request: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  return JSON.parse(Buffer.from(await readBody(request, limit)).toString("utf8"))
}
