import { createReadStream } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { extname, join, normalize, relative, resolve, sep } from "node:path"

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
}

export type WebAssetsHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>

export async function createWebAssetsHandler(root: string): Promise<WebAssetsHandler> {
  const assetRoot = await realpath(resolve(root))
  const indexPath = await safeFile(assetRoot, "index.html")
  if (indexPath === null) throw new TypeError("web asset root does not contain index.html")
  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") return false
    const requestTarget = request.url ?? "/"
    const pathname = new URL(requestTarget, "http://localhost").pathname
    let decoded: string
    let rawDecoded: string
    try {
      decoded = decodeURIComponent(pathname)
      rawDecoded = decodeURIComponent(requestTarget.split("?", 1)[0] ?? "/")
    } catch (error) {
      if (error instanceof URIError) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" })
        response.end("Invalid request path")
        return true
      }
      throw error
    }
    const boundaryPaths = [decoded, rawDecoded].map((value) => value.replaceAll("\\", "/"))
    if (
      boundaryPaths.some(
        (value) => value === "/health" || value === "/api" || value.startsWith("/api/"),
      )
    )
      return false
    const requested = decoded === "/" ? "index.html" : normalize(decoded).replace(/^[/\\]+/, "")
    const requestedFile = await safeFile(assetRoot, requested)
    if (requestedFile === null && extname(requested) !== "") {
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      })
      response.end("Not found")
      return true
    }
    const candidate = requestedFile ?? indexPath
    await serveFile(candidate, request.method, response)
    return true
  }
}

async function safeFile(root: string, requested: string): Promise<string | null> {
  const candidate = join(root, requested)
  const pathRelative = relative(root, candidate)
  if (pathRelative.startsWith(`..${sep}`) || pathRelative === "..") return null
  try {
    const resolved = await realpath(candidate)
    const resolvedRelative = relative(root, resolved)
    if (resolvedRelative.startsWith(`..${sep}`) || resolvedRelative === "..") return null
    return (await stat(resolved)).isFile() ? resolved : null
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

async function serveFile(path: string, method: string, response: ServerResponse): Promise<void> {
  const details = await stat(path)
  const contentType = CONTENT_TYPES[extname(path)] ?? "application/octet-stream"
  const immutable = path.includes(`${sep}assets${sep}`)
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": details.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  })
  if (method === "HEAD") {
    response.end()
    return
  }
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(path)
    stream.once("error", rejectStream)
    response.once("finish", resolveStream)
    stream.pipe(response)
  })
}
