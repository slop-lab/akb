import { runOutboxCli } from "../src/outbox/cli.ts"

const controller = new AbortController()
process.once("SIGTERM", () => controller.abort())
process.once("SIGINT", () => controller.abort())

try {
  const result = await runOutboxCli(process.argv.slice(2), process.env, controller.signal)
  process.stdout.write(`${result.output}\n`)
  if (!result.successful) process.exitCode = 1
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "invalid command"}\n`)
  process.exitCode = 1
}
