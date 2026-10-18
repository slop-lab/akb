import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  type BackupEnvironment,
  parseBackupCommand,
  restoreDatabaseUrl,
  sourceDatabaseUrl,
} from "./cli.ts"
import { createBackup } from "./create.ts"
import {
  decryptBackupArtifact,
  encryptBackupArtifact,
  isEncryptedBackupArtifact,
  loadBackupEncryptionKey,
} from "./encryption.ts"
import { BackupError } from "./errors.ts"
import { restoreBackup } from "./restore.ts"
import { applyBackupRetention } from "./retention.ts"
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
      return createEncryptedBackup(command.artifactDirectory, environment)
    case "verify": {
      return withReadableArtifact(command.artifactDirectory, environment, async (artifact) => {
        const manifest = await verifyBackupArtifact(
          artifact.directory,
          environment.PG_RESTORE_PATH ?? "pg_restore",
        )
        return JSON.stringify({
          artifactIntegrityVerified: true,
          authenticityVerified: artifact.authenticated,
          restoredSemanticsVerified: false,
          overallDigest: manifest.overallDigest,
          formatVersion: manifest.formatVersion,
          profile: manifest.formatVersion === 1 ? manifest.scope : manifest.profile,
        })
      })
    }
    case "restore":
      return withReadableArtifact(command.artifactDirectory, environment, async (artifact) =>
        JSON.stringify(
          await restoreBackup({
            artifactDirectory: artifact.directory,
            confirmedDatabase: command.confirmedDatabase,
            reportPath: command.reportPath,
            databaseUrl: restoreDatabaseUrl(environment),
            pgRestorePath: environment.PG_RESTORE_PATH ?? "pg_restore",
            artifactAuthenticated: artifact.authenticated,
            allowUnauthenticatedActivation: command.allowUnauthenticatedActivation,
          }),
        ),
      )
    case "retention":
      return JSON.stringify(
        await applyBackupRetention(
          command.backupRoot,
          {
            now: new Date(),
            maximumAgeDays: command.maximumAgeDays,
            minimumRetained: command.minimumRetained,
          },
          command.mode,
        ),
      )
  }
}

async function createEncryptedBackup(
  artifactDirectory: string,
  environment: BackupEnvironment,
): Promise<string> {
  const { key } = await loadBackupEncryptionKey(environment)
  const temporary = await mkdtemp(join(tmpdir(), "afw-backup-create-"))
  const plaintext = join(temporary, "artifact")
  try {
    const result = await createBackup(
      plaintext,
      sourceDatabaseUrl(environment),
      environment.PG_DUMP_PATH ?? "pg_dump",
    )
    await encryptBackupArtifact(plaintext, artifactDirectory, key)
    return JSON.stringify({ ...result, encryptedAtRest: true, authentication: "aes-256-gcm" })
  } finally {
    await rm(temporary, { recursive: true })
  }
}

async function withReadableArtifact<T>(
  artifactDirectory: string,
  environment: BackupEnvironment,
  operation: (artifact: {
    readonly directory: string
    readonly authenticated: boolean
  }) => Promise<T>,
): Promise<T> {
  if (!(await isEncryptedBackupArtifact(artifactDirectory))) {
    return operation({ directory: artifactDirectory, authenticated: false })
  }
  const { key } = await loadBackupEncryptionKey(environment)
  const temporary = await mkdtemp(join(tmpdir(), "afw-backup-read-"))
  const plaintext = join(temporary, "artifact")
  try {
    await decryptBackupArtifact(artifactDirectory, plaintext, key)
    return await operation({ directory: plaintext, authenticated: true })
  } finally {
    await rm(temporary, { recursive: true })
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
