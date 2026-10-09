import { createPostgresApplication } from "../src/postgres/application.ts"

const application = createPostgresApplication(process.env)
await application.sql`select 1 from work_items limit 0`
application.server.listen(application.port, application.host)

async function shutdown() {
  await new Promise((resolve, reject) =>
    application.server.close((error) => (error ? reject(error) : resolve())),
  )
  await application.sql.end({ timeout: 5 })
}

process.once("SIGINT", () => void shutdown())
process.once("SIGTERM", () => void shutdown())
