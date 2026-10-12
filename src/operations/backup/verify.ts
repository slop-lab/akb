import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { backupError } from "./errors.ts"
import { inspectArtifact } from "./files.ts"
import {
  assertManifestMigrationCatalog,
  type BackupManifest,
  manifestFromJson,
} from "./manifest.ts"
import { requireToolMajor, runTool } from "./process.ts"
import { readTrustedLocalProfiles } from "./profile-catalog.ts"
import { PROFILE_004, profileFromId } from "./profiles.ts"

export async function verifyBackupArtifact(
  artifactDirectory: string,
  pgRestorePath: string,
): Promise<BackupManifest> {
  const paths = await inspectArtifact(artifactDirectory)
  const manifest = manifestFromJson(await readFile(paths.manifest, "utf8"))
  await readTrustedLocalProfiles()
  assertManifestMigrationCatalog(
    manifest,
    manifest.formatVersion === 1
      ? PROFILE_004.migrations
      : profileFromId(manifest.profile).migrations,
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
