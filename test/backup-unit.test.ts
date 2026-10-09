import assert from "node:assert/strict"
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { BACKUP_HELP, parseBackupCommand, sourceDatabaseUrl } from "../src/operations/backup/cli.ts"
import { TABLES } from "../src/operations/backup/constants.ts"
import {
  createArtifactDirectory,
  inspectArtifact,
  openNewReportFile,
} from "../src/operations/backup/files.ts"
import {
  assertManifestMigrationCatalog,
  computeOverallDigest,
  computeMigrationDigest,
  createManifest,
  manifestFromJson,
  serializeManifest,
} from "../src/operations/backup/manifest.ts"
import { redactDiagnostic, runTool, toolConnection } from "../src/operations/backup/process.ts"
import {
  computeRecoveryOutcomeDigest,
  quarantineAssertions,
} from "../src/operations/backup/recovery.ts"
import { EXPECTED_SCHEMA_FINGERPRINT } from "../src/operations/backup/schema-policy.ts"

test("help is parsed without database configuration", () => {
  // Given
  const environment = {}

  // When
  const command = parseBackupCommand(["--help"], environment)

  // Then
  assert.deepEqual(command, { kind: "help", text: BACKUP_HELP })
})

test("strict command parsing rejects duplicate, unknown, and missing options", () => {
  // Given
  const environment = { SOURCE_DATABASE_URL: "postgres://operator:secret@db/source" }

  // When / Then
  assert.throws(
    () => parseBackupCommand(["create", "--artifact-dir", "a", "--artifact-dir", "b"], environment),
    /duplicate option/,
  )
  assert.throws(
    () => parseBackupCommand(["verify", "--artifact-dir", "a", "--extra", "b"], environment),
    /unknown option/,
  )
  assert.throws(() => parseBackupCommand(["create", "--artifact-dir"], environment), /value/)
})

test("source selection requires exactly one source variable", () => {
  // Given / When / Then
  assert.equal(
    sourceDatabaseUrl({ SOURCE_DATABASE_URL: "postgres://db/source" }),
    "postgres://db/source",
  )
  assert.throws(
    () =>
      sourceDatabaseUrl({
        SOURCE_DATABASE_URL: "postgres://db/source",
        DATABASE_URL: "postgres://db/legacy",
      }),
    /exactly one/,
  )
})

test("tool connection keeps passwords and query values out of argv", () => {
  // Given
  const raw = "postgres://operator:p%40ss@localhost:5433/fixture?sslmode=require"

  // When
  const connection = toolConnection(raw)

  // Then
  assert.deepEqual(connection.args, [
    "--dbname=postgres://operator@localhost:5433/fixture?sslmode=require",
  ])
  const { PGPASSWORD: password } = connection.environment
  assert.equal(password, "p@ss")
  assert.equal(JSON.stringify(connection.args).includes("p%40ss"), false)
})

test("tool connection preserves encoded database names as URI data", () => {
  // Given
  const raw =
    "postgres://operator:secret@trusted/host%3Devil.example%20port%3D5432%20dbname%3Dother"

  // When
  const connection = toolConnection(raw)

  // Then
  assert.deepEqual(connection.args, [
    "--dbname=postgres://operator@trusted/host%3Devil.example%20port%3D5432%20dbname%3Dother",
  ])
  assert.equal(connection.databaseName, "host=evil.example port=5432 dbname=other")
})

test("database URLs reject unknown, duplicate, and invalid connection options", () => {
  // Given / When / Then
  assert.throws(() => toolConnection("postgres://user@host/db?host=evil"), /invalid/)
  assert.throws(
    () => toolConnection("postgres://user@host/db?sslmode=require&sslmode=disable"),
    /invalid/,
  )
  assert.throws(() => toolConnection("postgres://user@host/db?sslmode=surprise"), /invalid/)
})

test("tool processes do not inherit ambient PostgreSQL variables", async () => {
  // Given
  const inherited = {
    PGSERVICE: process.env["PGSERVICE"],
    PGHOSTADDR: process.env["PGHOSTADDR"],
  }
  process.env["PGSERVICE"] = "redirected"
  process.env["PGHOSTADDR"] = "203.0.113.10"

  try {
    // When
    const result = await runTool({
      path: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({service:process.env.PGSERVICE,hostaddr:process.env.PGHOSTADDR,host:process.env.PGHOST}))",
      ],
      environment: { PGHOST: "trusted" },
      secrets: [],
    })

    // Then
    assert.deepEqual(JSON.parse(result.stdout), { host: "trusted" })
  } finally {
    if (inherited.PGSERVICE === undefined) delete process.env["PGSERVICE"]
    else process.env["PGSERVICE"] = inherited.PGSERVICE
    if (inherited.PGHOSTADDR === undefined) delete process.env["PGHOSTADDR"]
    else process.env["PGHOSTADDR"] = inherited.PGHOSTADDR
  }
})

test("diagnostics redact URL and password and stay bounded", () => {
  // Given
  const raw = "postgres://operator:secret@localhost/source"
  const diagnostic = `${raw} secret ${"x".repeat(10_000)}`

  // When
  const redacted = redactDiagnostic(diagnostic, [raw, "secret"])

  // Then
  assert.equal(redacted.includes("secret"), false)
  assert.equal(redacted.length <= 2_048, true)
})

test("quarantine proof rejects remaining active credentials and binds row digests", () => {
  // Given
  const input = {
    sourceOverallDigest: "a".repeat(64),
    schemaFingerprint: EXPECTED_SCHEMA_FINGERPRINT,
    baselineDigest: "b".repeat(64),
    postRecoveryDigest: "c".repeat(64),
    counts: {
      revokedCredentials: 1,
      leasedToPending: 1,
      leasedToDeadLetter: 0,
      generationIncrements: 1,
    },
    assertions: quarantineAssertions({ activeCredentials: 0, leasedJobs: 0 }),
  }

  // When
  const digest = computeRecoveryOutcomeDigest(input)
  const forged = computeRecoveryOutcomeDigest({ ...input, postRecoveryDigest: "d".repeat(64) })

  // Then
  assert.notEqual(forged, digest)
  assert.throws(() => quarantineAssertions({ activeCredentials: 1, leasedJobs: 0 }), /remain/)
})

test("artifact inspection rejects extras, symlinks, and insecure modes", async (context) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "afw-backup-unit-"))
  context.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true }))
  })
  const artifact = join(root, "artifact")
  await createArtifactDirectory(artifact)
  await writeFile(join(artifact, "archive.dump"), "archive", { mode: 0o600 })
  await writeFile(join(artifact, "manifest.json"), "{}", { mode: 0o600 })

  // When / Then
  await inspectArtifact(artifact)
  await writeFile(join(artifact, "extra"), "x")
  await assert.rejects(inspectArtifact(artifact), /exactly/)
  await import("node:fs/promises").then(({ rm }) => rm(join(artifact, "extra")))
  await chmod(join(artifact, "manifest.json"), 0o644)
  await assert.rejects(inspectArtifact(artifact), /0600/)
  await chmod(join(artifact, "manifest.json"), 0o600)
  await import("node:fs/promises").then(({ rm }) => rm(join(artifact, "archive.dump")))
  await symlink(join(artifact, "manifest.json"), join(artifact, "archive.dump"))
  await assert.rejects(inspectArtifact(artifact), /regular/)
  assert.equal((await lstat(artifact)).isDirectory(), true)
})

test("an open recovery report cannot be redirected to another file", async (context) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "afw-backup-report-"))
  context.after(() => rm(root, { recursive: true }))
  const reportPath = join(root, "report.json")
  const victimPath = join(root, "victim")
  await writeFile(victimPath, "preserve", { mode: 0o600 })
  const report = await openNewReportFile(reportPath)

  // When
  await rm(reportPath)
  await symlink(victimPath, reportPath)
  await report.writeFile("recovery")
  await report.close()

  // Then
  assert.equal(await readFile(victimPath, "utf8"), "preserve")
})

test("strict manifest detects semantic and serialized tampering", async () => {
  // Given
  const migrations = [
    {
      name: "001_work_item_persistence.sql",
      checksum: "e4280616dc2ea677ae7842fbdea46e1842153cd1833c35221216b2be88c1bdbf",
    },
    {
      name: "002_workspace_identity.sql",
      checksum: "0eabfb3cc71f1e8e9ce290ca445fa855b97b40bb03d69cc4964b688aae3ce0fd",
    },
    {
      name: "003_transactional_outbox.sql",
      checksum: "1303d40805ec9cb4c31612d22d0df129be6dedf256aaf629a7e76a743dba542f",
    },
    {
      name: "004_space_acl.sql",
      checksum: "37201b55de1b0f0ff9272f2b7c6bd563f27a2678d3f2ed3acab932daac472c2d",
    },
  ]
  const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  const manifest = createManifest({
    formatVersion: 1,
    scope: "r3-schema-004-public",
    snapshotStrategy: "repeatable-read-exported-snapshot",
    postgresMajor: 17,
    pgDumpMajor: 17,
    createdAt: "2026-10-09T12:00:00.000Z",
    sourceDatabase: "fixture",
    migrations,
    migrationDigest: computeMigrationDigest(migrations),
    schemaProjectionVersion: 2,
    schemaFingerprint: EXPECTED_SCHEMA_FINGERPRINT,
    tables: TABLES.map(({ name, order }) => ({
      name,
      order: order.map(({ column, kind }) => ({ column, kind })),
      rowCount: 0,
      sha256: emptyDigest,
    })),
    archive: { filename: "archive.dump", bytes: 0, sha256: emptyDigest },
  })

  // When
  const serialized = serializeManifest(manifest)
  const parsed = manifestFromJson(serialized)

  // Then
  assert.equal(parsed.overallDigest, computeOverallDigest(parsed))
  const tampered = JSON.parse(serialized)
  tampered.tables[0].rowCount += 1
  assert.throws(() => manifestFromJson(JSON.stringify(tampered)), /overall digest/)
  const archiveTampered = JSON.parse(serialized)
  archiveTampered.archive.bytes += 1
  assert.throws(() => manifestFromJson(JSON.stringify(archiveTampered)), /overall digest/)
  const metadataTampered = JSON.parse(serialized)
  metadataTampered.sourceDatabase = "forged"
  assert.throws(() => manifestFromJson(JSON.stringify(metadataTampered)), /overall digest/)
  const forgedMigrations = migrations.map((migration, index) =>
    index === 0 ? { ...migration, checksum: emptyDigest } : migration,
  )
  const forged = createManifest({
    ...manifest,
    migrations: forgedMigrations,
    migrationDigest: computeMigrationDigest(forgedMigrations),
  })
  assert.throws(() => assertManifestMigrationCatalog(forged, migrations), /trusted catalog/)
})
