import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ARTIFACT_FILES } from "./constants.ts"
import { backupError } from "./errors.ts"

export type ArtifactPaths = {
  readonly directory: string
  readonly archive: string
  readonly manifest: string
}

export async function createArtifactDirectory(directory: string): Promise<ArtifactPaths> {
  try {
    await mkdir(directory, { mode: 0o700 })
    await chmod(directory, 0o700)
  } catch (error) {
    throw backupError("artifact_path_rejected", "artifact directory must be a new path", error)
  }
  return artifactPaths(directory)
}

export async function inspectArtifact(directory: string): Promise<ArtifactPaths> {
  const directoryStat = await safeStat(directory)
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o777) !== 0o700) {
    throw backupError("artifact_path_rejected", "artifact directory must be a 0700 directory")
  }
  const entries = (await readdir(directory)).sort()
  if (entries.join("\0") !== [...ARTIFACT_FILES].sort().join("\0")) {
    throw backupError("artifact_path_rejected", "artifact directory must contain exactly two files")
  }
  const paths = artifactPaths(directory)
  await assertPrivateRegularFile(paths.archive)
  await assertPrivateRegularFile(paths.manifest)
  return paths
}

export async function openPrivateNewFile(path: string) {
  try {
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    )
    await handle.chmod(0o600)
    return handle
  } catch (error) {
    throw backupError("artifact_path_rejected", "output file must be a new path", error)
  }
}

export async function openNewReportFile(path: string) {
  const parent = await safeStat(dirname(path))
  if (!parent.isDirectory()) {
    throw backupError("report_path_rejected", "report parent must be a directory")
  }
  return openPrivateNewFile(path)
}

export async function assertPrivateRegularFile(path: string): Promise<void> {
  const file = await safeStat(path)
  if (!file.isFile())
    throw backupError("artifact_path_rejected", "artifact entries must be regular files")
  if ((file.mode & 0o777) !== 0o600) {
    throw backupError("artifact_path_rejected", "artifact files must have mode 0600")
  }
}

function artifactPaths(directory: string): ArtifactPaths {
  return {
    directory,
    archive: join(directory, "archive.dump"),
    manifest: join(directory, "manifest.json"),
  }
}

async function safeStat(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    throw backupError("artifact_path_rejected", "artifact path is unavailable", error)
  }
}
