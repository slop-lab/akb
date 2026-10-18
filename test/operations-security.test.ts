import assert from "node:assert/strict"
import { chmod, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parseBackupCommand } from "../src/operations/backup/cli.ts"
import {
  decryptBackupArtifact,
  encryptBackupArtifact,
  loadBackupEncryptionKey,
} from "../src/operations/backup/encryption.ts"
import { createArtifactDirectory, inspectArtifact } from "../src/operations/backup/files.ts"
import { PROFILE_004, PROFILE_010, PROFILE_016 } from "../src/operations/backup/profiles.ts"
import { applyBackupRetention, planBackupRetention } from "../src/operations/backup/retention.ts"
import { planForwardUpgrade } from "../src/operations/backup/upgrade.ts"

const KEY = Buffer.alloc(32, 7).toString("base64url")

test("encrypted artifact round trip keeps backup bytes out of the storage envelope", async (context) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "afw-encryption-"))
  context.after(() => rm(root, { recursive: true }))
  const source = join(root, "source")
  const encrypted = join(root, "encrypted")
  const restored = join(root, "restored")
  const paths = await createArtifactDirectory(source)
  await writeFile(paths.archive, "private archive payload", { mode: 0o600 })
  await writeFile(paths.manifest, '{"private":"manifest"}\n', { mode: 0o600 })

  // When
  await encryptBackupArtifact(source, encrypted, Buffer.from(KEY, "base64url"))
  await decryptBackupArtifact(encrypted, restored, Buffer.from(KEY, "base64url"))

  // Then
  const encryptedBytes = await readFile(join(encrypted, "payload.enc"))
  assert.equal(encryptedBytes.includes(Buffer.from("private archive payload")), false)
  const restoredPaths = await inspectArtifact(restored)
  assert.equal(await readFile(restoredPaths.archive, "utf8"), "private archive payload")
  assert.equal(await readFile(restoredPaths.manifest, "utf8"), '{"private":"manifest"}\n')
})

test("encrypted artifact authentication rejects a modified payload without releasing plaintext", async (context) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "afw-encryption-tamper-"))
  context.after(() => rm(root, { recursive: true }))
  const source = join(root, "source")
  const encrypted = join(root, "encrypted")
  const restored = join(root, "restored")
  const paths = await createArtifactDirectory(source)
  await writeFile(paths.archive, "archive", { mode: 0o600 })
  await writeFile(paths.manifest, "manifest", { mode: 0o600 })
  await encryptBackupArtifact(source, encrypted, Buffer.from(KEY, "base64url"))
  const payloadPath = join(encrypted, "payload.enc")
  const payload = await readFile(payloadPath)
  payload[0] = (payload[0] ?? 0) ^ 1
  await writeFile(payloadPath, payload, { mode: 0o600 })

  // When / Then
  await assert.rejects(
    decryptBackupArtifact(encrypted, restored, Buffer.from(KEY, "base64url")),
    /authentication/,
  )
  await assert.rejects(readFile(join(restored, "archive.dump")))
})

test("backup encryption key is read from exactly one private secret source", async (context) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "afw-encryption-key-"))
  context.after(() => rm(root, { recursive: true }))
  const keyPath = join(root, "key")
  await writeFile(keyPath, `${KEY}\n`, { mode: 0o600 })
  await chmod(keyPath, 0o600)

  // When / Then
  assert.deepEqual(await loadBackupEncryptionKey({ BACKUP_ENCRYPTION_KEY_FILE: keyPath }), {
    key: Buffer.from(KEY, "base64url"),
    source: "file",
  })
  await chmod(keyPath, 0o400)
  assert.equal(
    (await loadBackupEncryptionKey({ BACKUP_ENCRYPTION_KEY_FILE: keyPath })).source,
    "file",
  )
  await assert.rejects(
    loadBackupEncryptionKey({
      BACKUP_ENCRYPTION_KEY: KEY,
      BACKUP_ENCRYPTION_KEY_FILE: keyPath,
    }),
    /exactly one/,
  )
  await chmod(keyPath, 0o644)
  await assert.rejects(
    loadBackupEncryptionKey({ BACKUP_ENCRYPTION_KEY_FILE: keyPath }),
    /private file/,
  )
})

test("encrypted artifact publication preserves an existing destination on failure", async (context) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "afw-encryption-atomic-"))
  context.after(() => rm(root, { recursive: true }))
  const source = join(root, "source")
  const destination = join(root, "artifact")
  const paths = await createArtifactDirectory(source)
  await writeFile(paths.archive, "archive", { mode: 0o600 })
  await writeFile(paths.manifest, "manifest", { mode: 0o600 })
  await writeFile(destination, "operator-owned", { mode: 0o600 })

  // When / Then
  await assert.rejects(
    encryptBackupArtifact(source, destination, Buffer.from(KEY, "base64url")),
    /destination must be new/,
  )
  assert.equal(await readFile(destination, "utf8"), "operator-owned")
  assert.deepEqual(await readdir(root), ["artifact", "source"])
})

test("profile 016 includes every knowledge authority table", () => {
  assert.equal(
    PROFILE_016.tables.some(({ name }) => name === "knowledge_review_policies"),
    true,
  )
})

test("plaintext activation acknowledgement requires the exact unsafe phrase", () => {
  const base = [
    "restore",
    "--artifact-dir",
    "artifact",
    "--confirm-empty-database",
    "target",
    "--report",
    "report.json",
  ] as const
  assert.equal(parseBackupCommand(base, {}).kind, "restore")
  assert.throws(
    () => parseBackupCommand([...base, "--unsafe-allow-unauthenticated-activation", "yes"], {}),
    /I_ACCEPT_UNAUTHENTICATED_ARTIFACT/,
  )
  const accepted = parseBackupCommand(
    [...base, "--unsafe-allow-unauthenticated-activation", "I_ACCEPT_UNAUTHENTICATED_ARTIFACT"],
    {},
  )
  assert.equal(accepted.kind === "restore" && accepted.allowUnauthenticatedActivation, true)
})

test("backup retention preserves the newest successful artifact and reports only expired entries", () => {
  // Given
  const backups = [
    { name: "old", createdAt: new Date("2026-01-01T00:00:00Z") },
    { name: "recent", createdAt: new Date("2026-10-16T00:00:00Z") },
    { name: "newest", createdAt: new Date("2026-10-17T00:00:00Z") },
  ]

  // When
  const plan = planBackupRetention(backups, {
    now: new Date("2026-10-17T12:00:00Z"),
    maximumAgeDays: 30,
    minimumRetained: 2,
  })

  // Then
  assert.deepEqual(plan, { remove: ["old"], retain: ["newest", "recent"] })
})

test("backup retention apply removes only the entries selected by the prior dry run", async (context) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "afw-backup-retention-"))
  context.after(() => rm(root, { recursive: true }))
  for (const [name, timestamp] of [
    ["old", "2026-01-01T00:00:00Z"],
    ["new", "2026-10-17T00:00:00Z"],
  ] as const) {
    const source = join(root, `${name}-source`)
    const paths = await createArtifactDirectory(source)
    await writeFile(paths.archive, name, { mode: 0o600 })
    await writeFile(paths.manifest, name, { mode: 0o600 })
    const encrypted = join(root, name)
    await encryptBackupArtifact(source, encrypted, Buffer.from(KEY, "base64url"))
    await rm(source, { recursive: true })
    await utimes(encrypted, new Date(timestamp), new Date(timestamp))
  }
  const options = {
    now: new Date("2026-10-17T12:00:00Z"),
    maximumAgeDays: 30,
    minimumRetained: 1,
  }

  // When
  const dryRun = await applyBackupRetention(root, options, "dry-run")
  const applied = await applyBackupRetention(root, options, "apply")

  // Then
  assert.deepEqual(dryRun, { mode: "dry-run", remove: ["old"], retain: ["new"] })
  assert.deepEqual(applied, { mode: "apply", remove: ["old"], retain: ["new"] })
  await assert.rejects(readFile(join(root, "old", "envelope.json")))
  assert.equal((await readFile(join(root, "new", "envelope.json"))).length > 0, true)
})

test("backup retention fails closed on an owned-looking partial staging directory", async (context) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "afw-backup-partial-"))
  context.after(() => rm(root, { recursive: true }))
  const staging = join(root, ".artifact.afw-staging-interrupted")
  await createArtifactDirectory(staging)

  // When / Then
  await assert.rejects(
    applyBackupRetention(
      root,
      { now: new Date(), maximumAgeDays: 30, minimumRetained: 1 },
      "apply",
    ),
    /unexpected entries/,
  )
  assert.deepEqual(await readdir(root), [".artifact.afw-staging-interrupted"])
})

test("forward upgrade accepts only an exact immutable profile prefix", () => {
  // Given
  const currentCatalog = PROFILE_010.migrations.map((migration) => ({ ...migration }))

  // When
  const plan = planForwardUpgrade(PROFILE_004, PROFILE_010, currentCatalog)

  // Then
  assert.deepEqual(plan, PROFILE_010.migrations.slice(PROFILE_004.migrations.length))
  const first = currentCatalog[0]
  if (first === undefined) throw new TypeError("migration fixture is empty")
  assert.throws(
    () =>
      planForwardUpgrade(PROFILE_004, PROFILE_010, [
        { ...first, checksum: "0".repeat(64) },
        ...currentCatalog.slice(1),
      ]),
    /trusted profile/,
  )
})
