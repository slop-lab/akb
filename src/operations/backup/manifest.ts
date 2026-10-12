import { createHash } from "node:crypto"
import { z } from "zod"
import { backupError } from "./errors.ts"
import { PROFILE_004, PROFILE_008, PROFILE_009, PROFILE_010, profileFromId } from "./profiles.ts"

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
const ManifestMetadataSchema = {
  snapshotStrategy: z.literal("repeatable-read-exported-snapshot"),
  postgresMajor: z.literal(17),
  pgDumpMajor: z.literal(17),
  createdAt: z.iso.datetime(),
  sourceDatabase: z.string().min(1).max(63),
  migrations: z.array(MigrationSchema).readonly(),
  migrationDigest: HexDigestSchema,
  schemaProjectionVersion: z.literal(2),
} as const
const ManifestContentsSchema = {
  tables: z.array(TableDigestSchema).readonly(),
  archive: ArchiveSchema,
  overallDigest: HexDigestSchema,
} as const

const Format1ManifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  scope: z.literal("r3-schema-004-public"),
  ...ManifestMetadataSchema,
  schemaFingerprint: z.literal(PROFILE_004.schemaFingerprint),
  ...ManifestContentsSchema,
})

const Format2Manifest008Schema = z.strictObject({
  formatVersion: z.literal(2),
  profile: z.literal("r4-schema-008-public-v1"),
  ...ManifestMetadataSchema,
  schemaFingerprint: z.literal(PROFILE_008.schemaFingerprint),
  ...ManifestContentsSchema,
})

const Format2Manifest009Schema = z.strictObject({
  formatVersion: z.literal(2),
  profile: z.literal("r4-schema-009-public-v1"),
  ...ManifestMetadataSchema,
  schemaFingerprint: z.literal(PROFILE_009.schemaFingerprint),
  ...ManifestContentsSchema,
})

const Format2Manifest010Schema = z.strictObject({
  formatVersion: z.literal(2),
  profile: z.literal("r4-schema-010-public-v1"),
  ...ManifestMetadataSchema,
  schemaFingerprint: z.literal(PROFILE_010.schemaFingerprint),
  ...ManifestContentsSchema,
})

const ManifestShapeSchema = z.union([
  Format1ManifestSchema,
  Format2Manifest008Schema,
  Format2Manifest009Schema,
  Format2Manifest010Schema,
])

export type MigrationDigest = z.infer<typeof MigrationSchema>
export type TableDigest = z.infer<typeof TableDigestSchema>
export type BackupManifest = z.infer<typeof ManifestShapeSchema>
export type ManifestInput =
  | Omit<z.infer<typeof Format1ManifestSchema>, "overallDigest">
  | Omit<z.infer<typeof Format2Manifest008Schema>, "overallDigest">
  | Omit<z.infer<typeof Format2Manifest009Schema>, "overallDigest">
  | Omit<z.infer<typeof Format2Manifest010Schema>, "overallDigest">

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function computeMigrationDigest(migrations: readonly MigrationDigest[]): string {
  return sha256(
    migrations.map((migration) => `${migration.name}\0${migration.checksum}\n`).join(""),
  )
}

export function computeOverallDigest(manifest: ManifestInput | BackupManifest): string {
  const identity =
    manifest.formatVersion === 1
      ? { formatVersion: manifest.formatVersion, scope: manifest.scope }
      : { formatVersion: manifest.formatVersion, profile: manifest.profile }
  return sha256(
    JSON.stringify({
      ...identity,
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
  const profile = manifest.formatVersion === 1 ? PROFILE_004 : profileFromId(manifest.profile)
  if (
    manifest.migrations.map(({ name }) => name).join("\0") !==
    profile.migrations.map(({ name }) => name).join("\0")
  )
    throw backupError("invalid_manifest", "manifest migration catalog is not exact")
  if (manifest.migrationDigest !== computeMigrationDigest(manifest.migrations)) {
    throw backupError("invalid_manifest", "manifest migration digest is invalid")
  }
  const expectedTables = profile.tables.map(({ name, order }) => ({ name, order }))
  const actualTables = manifest.tables.map(({ name, order }) => ({ name, order }))
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    throw backupError("invalid_manifest", "manifest table catalog is not exact")
  }
  if (manifest.overallDigest !== computeOverallDigest(manifest)) {
    throw backupError("invalid_manifest", "manifest overall digest is invalid")
  }
  return manifest
}
