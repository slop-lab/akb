import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { readMigrationCatalog } from "../../postgres/migrate.ts"
import { inspectArtifact } from "./files.ts"
import { backupError } from "./errors.ts"
import {
  assertManifestMigrationCatalog,
  type BackupManifest,
  manifestFromJson,
} from "./manifest.ts"
import { requireToolMajor, runTool } from "./process.ts"

export async function verifyBackupArtifact(
  artifactDirectory: string,
  pgRestorePath: string,
): Promise<BackupManifest> {
  const paths = await inspectArtifact(artifactDirectory)
  const manifest = manifestFromJson(await readFile(paths.manifest, "utf8"))
  const migrationCatalog = await readMigrationCatalog()
  assertManifestMigrationCatalog(
    manifest,
    migrationCatalog.map(({ version, checksum }) => ({ name: version, checksum })),
  )
  const archive = await stat(paths.archive)
  const archiveDigest = await hashFile(paths.archive)
  if (archive.size !== manifest.archive.bytes || archiveDigest !== manifest.archive.sha256) {
    throw backupError("archive_digest_mismatch", "archive digest does not match manifest")
  }
  await requireToolMajor(pgRestorePath)
  await listBackupArchive(pgRestorePath, paths.archive)
  return manifest
}

export async function listBackupArchive(
  pgRestorePath: string,
  archivePath: string,
): Promise<string> {
  const result = await runTool({
    path: pgRestorePath,
    args: ["--list", archivePath],
    environment: {},
    secrets: [],
  })
  return result.stdout
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
