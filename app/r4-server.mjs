import { createServer } from "node:http"
import { createRequestTelemetryHandler } from "../src/http/request-telemetry.ts"
import { createWebAssetsHandler } from "../src/http/web-assets.ts"
import { createR4Application } from "../src/postgres/r4-application.ts"

const application = createR4Application(process.env)
const assets = await createWebAssetsHandler(process.env.WEB_ASSETS_DIR ?? "apps/web/dist")
await application.sql`select 1 from work_items limit 0`

const server = createServer(
  createRequestTelemetryHandler((request, response) => {
    assets(request, response)
      .then((handled) => {
        if (!handled) application.server.emit("request", request, response)
      })
      .catch(() => {
        if (response.headersSent) response.destroy()
        else {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          response.end("Internal server error")
        }
      })
  }),
)

server.listen(application.port, application.host)

async function shutdown() {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  await application.sql.end({ timeout: 5 })
}

process.once("SIGINT", () => void shutdown())
process.once("SIGTERM", () => void shutdown())
