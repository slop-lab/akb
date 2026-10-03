import { createServer as createHttpServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"

const HEALTH_RESPONSE = JSON.stringify({ status: "ok" })

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" })
    response.end(HEALTH_RESPONSE)
    return
  }

  response.writeHead(404, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify({ error: "not_found" }))
}

export function createServer(): Server {
  return createHttpServer(handleRequest)
}
