import { createServer } from "node:http"
import { createRuntimeRequestHandler } from "../build/src/http/runtime/index.js"
import { createPostgresClient, databaseUrlFromEnvironment } from "../build/src/postgres/client.js"

const signingKey = Buffer.from(process.env.RUNTIME_SIGNING_KEY ?? "", "base64url")
if (signingKey.byteLength < 32)
  throw new Error("RUNTIME_SIGNING_KEY must contain at least 32 bytes")

const sql = createPostgresClient(databaseUrlFromEnvironment(process.env), { maxConnections: 10 })
const runtime = createRuntimeRequestHandler(sql, signingKey)
const server = createServer((request, response) => {
  runtime(request, response)
    .then((handled) => {
      if (!handled) {
        response.writeHead(404, { "content-type": "application/json; charset=utf-8" })
        response.end(
          JSON.stringify({
            error: { code: "not_found", message: "not_found", retryable: false, details: {} },
          }),
        )
      }
    })
    .catch(() => {
      if (!response.headersSent)
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" })
      response.end(
        JSON.stringify({
          error: { code: "internal", message: "internal", retryable: false, details: {} },
        }),
      )
    })
})

const port = Number(process.env.RUNTIME_PORT ?? "3002")
server.listen(port, "127.0.0.1")

async function shutdown() {
  await new Promise((resolve) => server.close(resolve))
  await sql.end()
}

process.once("SIGINT", () => void shutdown())
process.once("SIGTERM", () => void shutdown())
