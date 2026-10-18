import { AutomationWorker } from "../build/src/automation/worker.js"
import { createPostgresClient, databaseUrlFromEnvironment } from "../build/src/postgres/client.js"
import { automationWorkerConfiguration } from "./automation-worker-config.mjs"

const { limit, interval } = automationWorkerConfiguration(process.env)
const sql = createPostgresClient(databaseUrlFromEnvironment(process.env), { maxConnections: 4 })
const worker = new AutomationWorker(sql)
let stopping = false

async function cycle() {
  await worker.runOnce(new Date(), limit)
}

async function main() {
  if (process.argv.includes("--once")) {
    await cycle()
    await sql.end()
    return
  }
  while (!stopping) {
    await cycle()
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  await sql.end()
}

function shutdown() {
  stopping = true
}
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : "automation worker failed")
  await sql.end()
  process.exitCode = 1
})
