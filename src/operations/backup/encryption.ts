import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { pipeline } from "node:stream/promises"
import { z } from "zod"
import { backupError } from "./errors.ts"
import { createArtifactDirectory, inspectArtifact } from "./files.ts"

const ALGORITHM = "aes-256-gcm" as const
const ENCRYPTED_FILES = ["envelope.json", "payload.enc"] as const
const EnvelopeSchema = z.strictObject({
  formatVersion: z.literal(1),
  algorithm: z.literal(ALGORITHM),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  authenticationTag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  manifestBytes: z.number().int().nonnegative(),
  archiveBytes: z.number().int().nonnegative(),
})

type EnvelopeCore = Omit<z.infer<typeof EnvelopeSchema>, "authenticationTag">
export type BackupKeyEnvironment = NodeJS.ProcessEnv & {
  readonly BACKUP_ENCRYPTION_KEY?: string
  readonly BACKUP_ENCRYPTION_KEY_FILE?: string
}

export async function loadBackupEncryptionKey(
  environment: BackupKeyEnvironment,
): Promise<{ readonly key: Buffer; readonly source: "environment" | "file" }> {
  const inline = environment.BACKUP_ENCRYPTION_KEY
  const file = environment.BACKUP_ENCRYPTION_KEY_FILE
  if ((inline === undefined) === (file === undefined)) {
    throw backupError("encryption_key_configuration", "configure exactly one backup encryption key")
  }
  if (file !== undefined) {
    const effectiveUid = process.geteuid?.()
    if (effectiveUid === undefined) {
      throw backupError("encryption_key_configuration", "backup key ownership is unavailable")
    }
    const metadata = await lstat(file)
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o077) !== 0 ||
      (metadata.mode & 0o400) === 0 ||
      metadata.uid !== effectiveUid
    ) {
      throw backupError("encryption_key_configuration", "backup key file must be a private file")
    }
    return { key: parseKey((await readFile(file, "utf8")).trim()), source: "file" }
  }
  return { key: parseKey(inline ?? ""), source: "environment" }
}

export async function encryptBackupArtifact(
  sourceDirectory: string,
  encryptedDirectory: string,
  key: Buffer,
): Promise<void> {
  assertKey(key)
  const source = await inspectArtifact(sourceDirectory)
  const manifest = await stat(source.manifest)
  const archive = await stat(source.archive)
  const nonce = randomBytes(12)
  const core: EnvelopeCore = {
    formatVersion: 1,
    algorithm: ALGORITHM,
    nonce: nonce.toString("base64url"),
    manifestBytes: manifest.size,
    archiveBytes: archive.size,
  }
  try {
    await lstat(encryptedDirectory)
    throw backupError("artifact_path_rejected", "encrypted artifact destination must be new")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  const staging = join(
    dirname(encryptedDirectory),
    `.${basename(encryptedDirectory)}.afw-staging-${randomUUID()}`,
  )
  const temporary = await mkdtemp(join(tmpdir(), "afw-encrypt-"))
  const combined = join(temporary, "plaintext")
  try {
    await mkdir(staging, { mode: 0o700 })
    await chmod(staging, 0o700)
    await combineArtifact(source.manifest, source.archive, combined)
    const cipher = createCipheriv(ALGORITHM, key, nonce)
    cipher.setAAD(Buffer.from(JSON.stringify(core)))
    await pipeline(
      createReadStream(combined),
      cipher,
      createWriteStream(join(staging, "payload.enc"), {
        flags: "wx",
        mode: 0o600,
      }),
    )
    const envelope = EnvelopeSchema.parse({
      ...core,
      authenticationTag: cipher.getAuthTag().toString("base64url"),
    })
    await writeFile(join(staging, "envelope.json"), `${JSON.stringify(envelope)}\n`, {
      flag: "wx",
      mode: 0o600,
    })
    await inspectEncryptedArtifact(staging)
    await rename(staging, encryptedDirectory)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw backupError("backup_encryption_failed", "backup artifact encryption failed", error)
  } finally {
    await rm(temporary, { recursive: true })
  }
}

export async function decryptBackupArtifact(
  encryptedDirectory: string,
  outputDirectory: string,
  key: Buffer,
): Promise<void> {
  assertKey(key)
  const paths = await inspectEncryptedArtifact(encryptedDirectory)
  const envelope = EnvelopeSchema.parse(JSON.parse(await readFile(paths.envelope, "utf8")))
  const core: EnvelopeCore = {
    formatVersion: envelope.formatVersion,
    algorithm: envelope.algorithm,
    nonce: envelope.nonce,
    manifestBytes: envelope.manifestBytes,
    archiveBytes: envelope.archiveBytes,
  }
  const temporary = await mkdtemp(join(tmpdir(), "afw-decrypt-"))
  const combined = join(temporary, "plaintext")
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.nonce, "base64url"))
    decipher.setAAD(Buffer.from(JSON.stringify(core)))
    decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64url"))
    await pipeline(
      createReadStream(paths.payload),
      decipher,
      createWriteStream(combined, { flags: "wx", mode: 0o600 }),
    )
    const combinedStat = await stat(combined)
    if (combinedStat.size !== envelope.manifestBytes + envelope.archiveBytes) {
      throw backupError("backup_authentication_failed", "authenticated backup length is invalid")
    }
    const output = await createArtifactDirectory(outputDirectory)
    await pipeline(
      createReadStream(combined, { start: 0, end: envelope.manifestBytes - 1 }),
      createWriteStream(output.manifest, { flags: "wx", mode: 0o600 }),
    )
    await pipeline(
      createReadStream(combined, { start: envelope.manifestBytes }),
      createWriteStream(output.archive, { flags: "wx", mode: 0o600 }),
    )
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true })
    throw backupError("backup_authentication_failed", "backup authentication failed", error)
  } finally {
    await rm(temporary, { recursive: true })
  }
}

export async function isEncryptedBackupArtifact(directory: string): Promise<boolean> {
  const entries = await readdir(directory)
  return entries.sort().join("\0") === [...ENCRYPTED_FILES].sort().join("\0")
}

async function combineArtifact(manifest: string, archive: string, output: string): Promise<void> {
  await pipeline(
    createReadStream(manifest),
    createWriteStream(output, { flags: "wx", mode: 0o600 }),
  )
  await pipeline(createReadStream(archive), createWriteStream(output, { flags: "a", mode: 0o600 }))
}

export async function inspectEncryptedArtifact(directory: string) {
  const metadata = await lstat(directory)
  if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
    throw backupError("artifact_path_rejected", "encrypted artifact must be a 0700 directory")
  }
  const entries = (await readdir(directory)).sort()
  if (entries.join("\0") !== [...ENCRYPTED_FILES].sort().join("\0")) {
    throw backupError("artifact_path_rejected", "encrypted artifact has unexpected entries")
  }
  const envelope = join(directory, "envelope.json")
  const payload = join(directory, "payload.enc")
  for (const path of [envelope, payload]) {
    const file = await lstat(path)
    if (!file.isFile() || (file.mode & 0o777) !== 0o600) {
      throw backupError("artifact_path_rejected", "encrypted artifact files must be private")
    }
  }
  return { envelope, payload } as const
}

function parseKey(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw backupError(
      "encryption_key_configuration",
      "backup encryption key must be 32-byte base64url",
    )
  }
  const key = Buffer.from(encoded, "base64url")
  assertKey(key)
  return key
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw backupError("encryption_key_configuration", "backup encryption key must be 32 bytes")
  }
}
