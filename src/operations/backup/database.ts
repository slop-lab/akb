import { createHash } from "node:crypto"
import postgres, { type Sql, type TransactionSql } from "postgres"
import { z } from "zod"
import { parsePostgresDatabaseUrl } from "../../postgres/database-url.ts"
import { schemaFingerprint } from "./catalog.ts"
import { POSTGRES_MAJOR } from "./constants.ts"
import { backupError } from "./errors.ts"
import type { MigrationDigest, TableDigest } from "./manifest.ts"
import { trustedProfileFromDatabaseLedger } from "./profile-catalog.ts"
import { type BackupProfile, PROFILE_004, profileFromLedger } from "./profiles.ts"

const VersionRowSchema = z.strictObject({ version: z.string(), checksum: z.string().length(64) })
const StringRowSchema = z.strictObject({ value: z.string() })
const NumberRowSchema = z.strictObject({ value: z.coerce.number().int().nonnegative() })
const BooleanRowSchema = z.strictObject({ value: z.boolean() })

export function createBackupClient(databaseUrl: string): Sql {
  return postgres(parsePostgresDatabaseUrl(databaseUrl).clientUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      application_name: "agent-first-workspace-backup",
      statement_timeout: 600_000,
      lock_timeout: 5_000,
    },
  })
}

export async function serverMajor(sql: Sql | TransactionSql): Promise<number> {
  const rows = await sql`select (current_setting('server_version_num')::integer / 10000) as value`
  return NumberRowSchema.parse(rows[0]).value
}

export async function databaseName(sql: Sql | TransactionSql): Promise<string> {
  const rows = await sql`select current_database() as value`
  return StringRowSchema.parse(rows[0]).value
}

export async function prepareSnapshot(
  transaction: TransactionSql,
  profile: BackupProfile,
): Promise<{
  readonly snapshot: string
  readonly schemaFingerprint: string
}> {
  await configureCanonicalSession(transaction)
  const actualSchemaFingerprint = await validateApplicationDatabase(transaction, profile.migrations)
  await transaction.unsafe(
    `lock table public.schema_migrations, ${profile.tables.map(({ name }) => `public.${name}`).join(", ")} in access share mode`,
  )
  const rows = await transaction`select pg_export_snapshot() as value`
  return {
    snapshot: StringRowSchema.parse(rows[0]).value,
    schemaFingerprint: actualSchemaFingerprint,
  }
}

export async function configureCanonicalSession(sql: TransactionSql): Promise<void> {
  await sql`set local search_path = pg_catalog, public`
  await sql`set local timezone = 'UTC'`
  await sql`set local datestyle = 'ISO, YMD'`
  await sql`set local bytea_output = 'hex'`
  await sql`set local client_encoding = 'UTF8'`
}

export async function validateApplicationDatabase(
  sql: TransactionSql,
  expectedMigrations: readonly MigrationDigest[],
): Promise<string> {
  await configureCanonicalSession(sql)
  if ((await serverMajor(sql)) !== POSTGRES_MAJOR) {
    throw backupError("server_version_mismatch", "PostgreSQL server major version must be 17")
  }
  const migrationRows =
    await sql`select version, checksum from public.schema_migrations order by version`
  const applied = migrationRows.map((row) => VersionRowSchema.parse(row))
  const profile = profileFromLedger(expectedMigrations)
  const expectedLedger = profile.migrations.map(({ name, checksum }) => ({
    version: name,
    checksum,
  }))
  if (JSON.stringify(applied) !== JSON.stringify(expectedLedger)) {
    throw backupError("database_shape_mismatch", "database migration ledger is not exact")
  }
  const fingerprint = await schemaFingerprint(sql)
  if (fingerprint !== profile.schemaFingerprint) {
    throw backupError("database_shape_mismatch", "database schema fingerprint is not exact")
  }
  return fingerprint
}

export async function digestTables(
  sql: TransactionSql,
  projection: "full" | "protected" = "full",
  profile: BackupProfile = PROFILE_004,
): Promise<readonly TableDigest[]> {
  await configureCanonicalSession(sql)
  const digests: TableDigest[] = []
  for (const table of profile.tables) {
    let expression = "to_jsonb(t)"
    let filter = ""
    if (projection === "protected" && table.name === "principal_credentials") {
      expression = "to_jsonb(t) - 'revoked_at'"
    }
    if (projection === "protected" && table.name === "outbox_jobs") {
      expression = "to_jsonb(t) - 'state' - 'lease_owner' - 'lease_expires_at' - 'lease_generation'"
    }
    if (projection === "protected" && table.name === "entity_outbox_jobs_v1") {
      expression = "to_jsonb(t) - 'state' - 'lease_owner' - 'lease_expires_at' - 'lease_generation'"
    }
    if (projection === "protected" && table.name.startsWith("human_query_snapshot"))
      filter = " where false"
    if (projection === "protected" && table.name === "import_batches")
      filter = " where t.state = 'committed'"
    if (projection === "protected" && table.name === "import_record_ids") {
      filter =
        " where exists (select 1 from public.import_batches b where b.import_id = t.import_id and b.state = 'committed')"
    }
    if (projection === "protected" && table.name === "runtime_runs")
      expression =
        "to_jsonb(t) - 'token_hash' - 'token_expires_at' - 'generation' - 'state' - 'updated_at'"
    if (projection === "protected" && table.name === "runtime_leases")
      expression = "to_jsonb(t) - 'status' - 'expires_at' - 'heartbeat_deadline'"
    if (projection === "protected" && table.name === "agent_installations")
      expression = "to_jsonb(t) - 'enabled'"
    if (projection === "protected" && table.name === "extension_installations")
      expression = "to_jsonb(t) - 'enabled'"
    if (projection === "protected" && table.name === "runtime_endpoints")
      expression = "to_jsonb(t) - 'enabled'"
    if (projection === "protected" && table.name === "github_installations")
      expression = "to_jsonb(t) - 'webhook_secret'"
    if (projection === "protected" && table.name === "recurrence_rules")
      expression = "to_jsonb(t) - 'enabled'"
    if (projection === "protected" && table.name === "automation_rules")
      expression = "to_jsonb(t) - 'enabled'"
    if (projection === "protected" && table.name === "automation_runs")
      expression = "to_jsonb(t) - 'state' - 'completed_at'"
    if (projection === "protected" && table.name === "automation_action_jobs")
      expression = "to_jsonb(t) - 'state'"
    if (projection === "protected" && table.name === "outgoing_https_requests")
      expression = "to_jsonb(t) - 'state' - 'lease_owner' - 'lease_generation' - 'lease_expires_at'"
    if (projection === "protected" && table.name === "github_webhook_deliveries")
      expression = "to_jsonb(t) - 'state'"
    if (
      projection === "protected" &&
      ["runtime_context_snapshots", "runtime_context_entries", "content_presence"].includes(
        table.name,
      )
    )
      filter = " where false"
    const order = table.order
      .map(({ column, kind }) =>
        kind === "text"
          ? `convert_to(t.${column}::text, 'UTF8') asc nulls first`
          : `t.${column} asc nulls first`,
      )
      .join(", ")
    const query = `copy (select (${expression})::text from public.${table.name} t${filter} order by ${order}) to stdout with (format text, encoding 'UTF8')`
    const stream = await sql.unsafe(query).readable()
    const hash = createHash("sha256")
    let rowCount = 0
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      hash.update(bytes)
      for (const byte of bytes) if (byte === 10) rowCount += 1
    }
    digests.push({
      name: table.name,
      order: table.order.map(({ column, kind }) => ({ column, kind })),
      rowCount,
      sha256: hash.digest("hex"),
    })
  }
  return digests
}

export async function readDatabaseProfile(sql: Sql | TransactionSql): Promise<BackupProfile> {
  const rows = await sql`select version, checksum from public.schema_migrations order by version`
  const ledger = rows.map((row) => {
    const parsed = VersionRowSchema.parse(row)
    return { name: parsed.version, checksum: parsed.checksum }
  })
  return trustedProfileFromDatabaseLedger(ledger)
}

export async function validateEmptyTarget(sql: Sql, confirmedDatabase: string): Promise<void> {
  if ((await serverMajor(sql)) !== POSTGRES_MAJOR) {
    throw backupError("target_rejected", "target PostgreSQL server major version must be 17")
  }
  if ((await databaseName(sql)) !== confirmedDatabase) {
    throw backupError("target_rejected", "target database confirmation does not match")
  }
  const checks = await sql`select
    (select pg_get_userbyid(datdba) = current_user from pg_database where datname = current_database()) as owner,
    current_setting('server_encoding') = 'UTF8' as encoding,
    not pg_is_in_recovery() as primary,
    (select count(*) = 0 from pg_stat_activity where datname = current_database()
      and pid <> pg_backend_pid()) as sessions,
    (select array_agg(nspname::text order by nspname) = array['information_schema','pg_catalog','pg_toast','public']
      from pg_namespace where nspname not like 'pg_toast_temp_%' and nspname not like 'pg_temp_%') as schemas,
    (select pg_get_userbyid(nspowner) = 'pg_database_owner'
      and nspacl::text = '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}'
      from pg_namespace where nspname = 'public') as public_default,
    (select count(*) = 0 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public') as relations,
    (select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public') as routines,
    (select count(*) = 0 from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public') as types,
    (select count(*) = 0 from pg_largeobject_metadata) as large_objects,
    (select count(*) = 0 from pg_event_trigger) as event_triggers,
    (select count(*) = 0 from pg_publication) as publications,
    (select count(*) = 0 from pg_subscription) as subscriptions,
    (select count(*) = 0 from pg_default_acl) as default_privileges,
    (select array_agg(extname::text order by extname) = array['plpgsql'] from pg_extension) as extensions`
  const row = z
    .strictObject({
      owner: z.boolean(),
      encoding: z.boolean(),
      primary: z.boolean(),
      sessions: z.boolean(),
      schemas: z.boolean(),
      public_default: z.boolean(),
      relations: z.boolean(),
      routines: z.boolean(),
      types: z.boolean(),
      large_objects: z.boolean(),
      event_triggers: z.boolean(),
      publications: z.boolean(),
      subscriptions: z.boolean(),
      default_privileges: z.boolean(),
      extensions: z.boolean(),
    })
    .parse(checks[0])
  if (!Object.values(row).every(Boolean)) {
    throw backupError(
      "target_rejected",
      "target database is not a pristine owned template0 database",
    )
  }
}

export async function hasApplicationTables(sql: Sql): Promise<boolean> {
  const rows = await sql`select to_regclass('public.schema_migrations') is not null as value`
  return BooleanRowSchema.parse(rows[0]).value
}
