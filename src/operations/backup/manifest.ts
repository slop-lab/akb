import { createHash } from "node:crypto"
import { z } from "zod"
import { EXPECTED_MIGRATIONS, TABLES } from "./constants.ts"
import { backupError } from "./errors.ts"
import { EXPECTED_SCHEMA_FINGERPRINT } from "./schema-policy.ts"

const HexDigestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const MigrationSchema = z.strictObject({
  name: z.string(),
  checksum: HexDigestSchema,
})
const TableDigestSchema = z.strictObject({
  name: z.string(),
  order: z
    .array(z.strictObject({ column: z.string(), kind: z.enum(["text", "numeric"]) }))
    .readonly(),
  rowCount: z.number().int().nonnegative(),
  sha256: HexDigestSchema,
})
const ArchiveSchema = z.strictObject({
  filename: z.literal("archive.dump"),
  bytes: z.number().int().nonnegative(),
  sha256: HexDigestSchema,
})
const ManifestShapeSchema = z.strictObject({
  formatVersion: z.literal(1),
  scope: z.literal("r3-schema-004-public"),
  snapshotStrategy: z.literal("repeatable-read-exported-snapshot"),
  postgresMajor: z.literal(17),
  pgDumpMajor: z.literal(17),
  createdAt: z.iso.datetime(),
  sourceDatabase: z.string().min(1).max(63),
  migrations: z.array(MigrationSchema).readonly(),
  migrationDigest: HexDigestSchema,
  schemaProjectionVersion: z.literal(2),
  schemaFingerprint: z.literal(EXPECTED_SCHEMA_FINGERPRINT),
  tables: z.array(TableDigestSchema).readonly(),
  archive: ArchiveSchema,
  overallDigest: HexDigestSchema,
})

export type MigrationDigest = z.infer<typeof MigrationSchema>
export type TableDigest = z.infer<typeof TableDigestSchema>
export type BackupManifest = z.infer<typeof ManifestShapeSchema>
export type ManifestInput = Omit<BackupManifest, "overallDigest">

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function computeMigrationDigest(migrations: readonly MigrationDigest[]): string {
  return sha256(
    migrations.map((migration) => `${migration.name}\0${migration.checksum}\n`).join(""),
  )
}

export function computeOverallDigest(manifest: ManifestInput | BackupManifest): string {
  return sha256(
    JSON.stringify({
      formatVersion: manifest.formatVersion,
      scope: manifest.scope,
      snapshotStrategy: manifest.snapshotStrategy,
      postgresMajor: manifest.postgresMajor,
      pgDumpMajor: manifest.pgDumpMajor,
      createdAt: manifest.createdAt,
      sourceDatabase: manifest.sourceDatabase,
      migrations: manifest.migrations,
      migrationDigest: manifest.migrationDigest,
      schemaProjectionVersion: manifest.schemaProjectionVersion,
      schemaFingerprint: manifest.schemaFingerprint,
      tables: manifest.tables,
      archive: manifest.archive,
    }),
  )
}

export function computeSemanticDigest(
  migrationDigest: string,
  tables: readonly TableDigest[],
): string {
  return sha256(
    JSON.stringify({
      migrationDigest,
      tables: tables.map(({ name, rowCount, sha256: digest }) => ({
        name,
        rowCount,
        sha256: digest,
      })),
    }),
  )
}

export function createManifest(input: ManifestInput): BackupManifest {
  return validateManifest({ ...input, overallDigest: computeOverallDigest(input) })
}

export function manifestFromJson(value: string): BackupManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw backupError("invalid_manifest", "manifest is not valid JSON", error)
  }
  return validateManifest(parsed)
}

export function serializeManifest(manifest: BackupManifest): string {
  return `${JSON.stringify(validateManifest(manifest), null, 2)}\n`
}

export function assertManifestMigrationCatalog(
  manifest: BackupManifest,
  expected: readonly MigrationDigest[],
): void {
  if (JSON.stringify(manifest.migrations) !== JSON.stringify(expected)) {
    throw backupError("invalid_manifest", "manifest migrations do not match trusted catalog")
  }
}

function validateManifest(value: unknown): BackupManifest {
  const manifest = ManifestShapeSchema.parse(value)
  const expectedMigrations = [...EXPECTED_MIGRATIONS]
  if (manifest.migrations.map(({ name }) => name).join("\0") !== expectedMigrations.join("\0")) {
    throw backupError("invalid_manifest", "manifest migration catalog is not exact")
  }
  if (manifest.migrationDigest !== computeMigrationDigest(manifest.migrations)) {
    throw backupError("invalid_manifest", "manifest migration digest is invalid")
  }
  const expectedTables = TABLES.map(({ name, order }) => ({ name, order }))
  const actualTables = manifest.tables.map(({ name, order }) => ({ name, order }))
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw backupError("invalid_manifest", "manifest table catalog is not exact")
  }
  if (manifest.overallDigest !== computeOverallDigest(manifest)) {
    throw backupError("invalid_manifest", "manifest overall digest is invalid")
  }
  return manifest
}
