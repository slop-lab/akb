import { stat } from "node:fs/promises"
import {
  createBackupClient,
  databaseName,
  digestTables,
  prepareSnapshot,
  readDatabaseProfile,
  serverMajor,
} from "./database.ts"
import { createArtifactDirectory, openPrivateNewFile } from "./files.ts"
import { computeMigrationDigest, createManifest, serializeManifest } from "./manifest.ts"
import { requireToolMajor, runTool, toolConnection } from "./process.ts"
import { hashFile } from "./verify.ts"

export async function createBackup(
  artifactDirectory: string,
  databaseUrl: string,
  pgDumpPath: string,
): Promise<{
  readonly overallDigest: string
  readonly formatVersion: 1 | 2
  readonly profile: "r3-schema-004-public" | "r4-schema-008-public-v1"
}> {
  const paths = await createArtifactDirectory(artifactDirectory)
  const connection = toolConnection(databaseUrl)
  await requireToolMajor(pgDumpPath)
  const sql = createBackupClient(databaseUrl)
  try {
    const archiveHandle = await openPrivateNewFile(paths.archive)
    try {
      const snapshotResult = await sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => {
          const profile = await readDatabaseProfile(transaction)
          const prepared = await prepareSnapshot(transaction, profile)
          const dump = runTool({
            path: pgDumpPath,
            args: [
              "--format=custom",
              `--snapshot=${prepared.snapshot}`,
              "--schema=public",
              "--strict-names",
              "--no-acl",
              "--no-comments",
              "--no-publications",
              "--no-subscriptions",
              "--no-password",
              ...connection.args,
            ],
            environment: {
              ...connection.environment,
              PGAPPNAME: "agent-first-workspace-pg-dump",
            },
            secrets: connection.secrets,
            stdoutFile: archiveHandle,
          })
          await dump
          const tables = await digestTables(transaction, "full", profile)
          return {
            profile,
            tables,
            schemaFingerprint: prepared.schemaFingerprint,
            postgresMajor: await serverMajor(transaction),
            sourceDatabase: await databaseName(transaction),
          }
        },
      )
      await archiveHandle.sync()
      const archiveStat = await stat(paths.archive)
      const common = {
        snapshotStrategy: "repeatable-read-exported-snapshot",
        postgresMajor: 17,
        pgDumpMajor: 17,
        createdAt: new Date().toISOString(),
        sourceDatabase: snapshotResult.sourceDatabase,
        migrations: snapshotResult.profile.migrations,
        migrationDigest: computeMigrationDigest(snapshotResult.profile.migrations),
        schemaProjectionVersion: 2,
        schemaFingerprint: snapshotResult.schemaFingerprint,
        tables: snapshotResult.tables,
        archive: {
          filename: "archive.dump",
          bytes: archiveStat.size,
          sha256: await hashFile(paths.archive),
        },
      } as const
      const manifest = createManifest(
        snapshotResult.profile.id === "r3-schema-004-public"
          ? { formatVersion: 1, scope: "r3-schema-004-public", ...common }
          : { formatVersion: 2, profile: "r4-schema-008-public-v1", ...common },
      )
      const manifestHandle = await openPrivateNewFile(paths.manifest)
      try {
        await manifestHandle.writeFile(serializeManifest(manifest), "utf8")
        await manifestHandle.sync()
      } finally {
        await manifestHandle.close()
      }
      return {
        overallDigest: manifest.overallDigest,
        formatVersion: manifest.formatVersion,
        profile: manifest.formatVersion === 1 ? manifest.scope : manifest.profile,
      }
    } finally {
      await archiveHandle.close()
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}
