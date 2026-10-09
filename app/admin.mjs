import { runAdminCli } from "../src/identity/admin-cli.ts"

try {
  const output = await runAdminCli(process.argv.slice(2), process.env)
  process.stdout.write(`${output}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "invalid command"}\n`)
  process.exitCode = 1
}
