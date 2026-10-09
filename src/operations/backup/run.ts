import { z } from "zod"
import {
  type BackupEnvironment,
  parseBackupCommand,
  restoreDatabaseUrl,
  sourceDatabaseUrl,
} from "./cli.ts"
import { createBackup } from "./create.ts"
import { BackupError } from "./errors.ts"
import { restoreBackup } from "./restore.ts"
import { verifyBackupArtifact } from "./verify.ts"

export async function runBackupCli(
  args: readonly string[],
  environment: BackupEnvironment,
): Promise<string> {
  const command = parseBackupCommand(args, environment)
  switch (command.kind) {
    case "help":
      return command.text
    case "create":
      return JSON.stringify(
        await createBackup(
          command.artifactDirectory,
          sourceDatabaseUrl(environment),
          environment.PG_DUMP_PATH ?? "pg_dump",
        ),
      )
    case "verify": {
      const manifest = await verifyBackupArtifact(
        command.artifactDirectory,
        environment.PG_RESTORE_PATH ?? "pg_restore",
      )
      return JSON.stringify({
        artifactIntegrityVerified: true,
        authenticityVerified: false,
        restoredSemanticsVerified: false,
        overallDigest: manifest.overallDigest,
      })
    }
    case "restore":
      return JSON.stringify(
        await restoreBackup({
          artifactDirectory: command.artifactDirectory,
          confirmedDatabase: command.confirmedDatabase,
          reportPath: command.reportPath,
          databaseUrl: restoreDatabaseUrl(environment),
          pgRestorePath: environment.PG_RESTORE_PATH ?? "pg_restore",
        }),
      )
  }
}

export function publicBackupError(error: unknown): {
  readonly code: string
  readonly message: string
} {
  if (error instanceof BackupError) return { code: error.code, message: error.message }
  if (error instanceof z.ZodError || error instanceof TypeError) {
    return { code: "invalid_input", message: "backup input is invalid" }
  }
  return { code: "backup_failed", message: "backup operation failed" }
}
