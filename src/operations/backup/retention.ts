import { lstat, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { inspectEncryptedArtifact } from "./encryption.ts"
import { backupError } from "./errors.ts"

const RetentionOptionsSchema = z.strictObject({
  now: z.date(),
  maximumAgeDays: z.number().int().positive(),
  minimumRetained: z.number().int().positive(),
})

export type BackupRetentionEntry = {
  readonly name: string
  readonly createdAt: Date
}

export type BackupRetentionPlan = {
  readonly remove: readonly string[]
  readonly retain: readonly string[]
}

export type BackupRetentionResult = BackupRetentionPlan & {
  readonly mode: "dry-run" | "apply"
}

export function planBackupRetention(
  entries: readonly BackupRetentionEntry[],
  options: {
    readonly now: Date
    readonly maximumAgeDays: number
    readonly minimumRetained: number
  },
): BackupRetentionPlan {
  const parsed = RetentionOptionsSchema.parse(options)
  const ordered = [...entries].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
  )
  const threshold = parsed.now.getTime() - parsed.maximumAgeDays * 24 * 60 * 60 * 1_000
  const retained = ordered.filter(
    (entry, index) => index < parsed.minimumRetained || entry.createdAt.getTime() >= threshold,
  )
  const retainedNames = new Set(retained.map(({ name }) => name))
  return Object.freeze({
    remove: Object.freeze(
      ordered.filter(({ name }) => !retainedNames.has(name)).map(({ name }) => name),
    ),
    retain: Object.freeze(retained.map(({ name }) => name)),
  })
}

export async function applyBackupRetention(
  root: string,
  options: {
    readonly now: Date
    readonly maximumAgeDays: number
    readonly minimumRetained: number
  },
  mode: "dry-run" | "apply",
): Promise<BackupRetentionResult> {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory()) {
    throw backupError("retention_path_rejected", "backup retention root must be a directory")
  }
  const entries = await readdir(root, { withFileTypes: true })
  const backups: BackupRetentionEntry[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw backupError("retention_path_rejected", "backup retention root has an unexpected entry")
    }
    const directory = join(root, entry.name)
    await inspectEncryptedArtifact(directory)
    const metadata = await lstat(directory)
    backups.push({ name: entry.name, createdAt: metadata.mtime })
  }
  const plan = planBackupRetention(backups, options)
  if (mode === "apply") {
    for (const name of plan.remove) await rm(join(root, name), { recursive: true })
  }
  return Object.freeze({ mode, ...plan })
}
