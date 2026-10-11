import { runRetentionCli } from "../src/operations/retention/cli.ts"

try {
  process.stdout.write(`${await runRetentionCli(process.argv.slice(2), process.env)}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "invalid command"}\n`)
  process.exitCode = 1
}
