import { stat } from "node:fs/promises"
import { readMigrationCatalog } from "../../postgres/migrate.ts"
import { createArtifactDirectory, openPrivateNewFile } from "./files.ts"
import {
  createBackupClient,
  databaseName,
  digestTables,
  prepareSnapshot,
  serverMajor,
} from "./database.ts"
import {
  computeMigrationDigest,
  createManifest,
  serializeManifest,
  type MigrationDigest,
} from "./manifest.ts"
import { hashFile } from "./verify.ts"
import { requireToolMajor, runTool, toolConnection } from "./process.ts"

export async function createBackup(
  artifactDirectory: string,
  databaseUrl: string,
  pgDumpPath: string,
): Promise<{ readonly overallDigest: string }> {
  const paths = await createArtifactDirectory(artifactDirectory)
  const connection = toolConnection(databaseUrl)
  await requireToolMajor(pgDumpPath)
  const migrationCatalog = await readMigrationCatalog()
  const migrations: readonly MigrationDigest[] = migrationCatalog.map(({ version, checksum }) => ({
    name: version,
    checksum,
  }))
  const sql = createBackupClient(databaseUrl)
  try {
    const archiveHandle = await openPrivateNewFile(paths.archive)
    try {
      const snapshotResult = await sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => {
          const prepared = await prepareSnapshot(transaction, migrations)
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
          const tables = await digestTables(transaction)
          return {
            tables,
            schemaFingerprint: prepared.schemaFingerprint,
            postgresMajor: await serverMajor(transaction),
            sourceDatabase: await databaseName(transaction),
          }
        },
      )
      await archiveHandle.sync()
      const archiveStat = await stat(paths.archive)
      const manifest = createManifest({
        formatVersion: 1,
        scope: "r3-schema-004-public",
        snapshotStrategy: "repeatable-read-exported-snapshot",
        postgresMajor: 17,
        pgDumpMajor: 17,
        createdAt: new Date().toISOString(),
        sourceDatabase: snapshotResult.sourceDatabase,
        migrations,
        migrationDigest: computeMigrationDigest(migrations),
        schemaProjectionVersion: 2,
        schemaFingerprint: snapshotResult.schemaFingerprint,
        tables: snapshotResult.tables,
        archive: {
          filename: "archive.dump",
          bytes: archiveStat.size,
          sha256: await hashFile(paths.archive),
        },
      })
      const manifestHandle = await openPrivateNewFile(paths.manifest)
      try {
        await manifestHandle.writeFile(serializeManifest(manifest), "utf8")
        await manifestHandle.sync()
      } finally {
        await manifestHandle.close()
      }
      return { overallDigest: manifest.overallDigest }
    } finally {
      await archiveHandle.close()
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}
