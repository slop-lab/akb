import { publicBackupError, runBackupCli } from "../src/operations/backup/run.ts"

try {
  process.stdout.write(`${await runBackupCli(process.argv.slice(2), process.env)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify(publicBackupError(error))}\n`)
  process.exitCode = 1
}
