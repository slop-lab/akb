import { z } from "zod"
import { backupError } from "./errors.ts"

export const BACKUP_HELP = `Usage: npm run backup -- <command> [options]

Commands:
  create  --artifact-dir NEW_PATH
  verify  --artifact-dir ARTIFACT_PATH
  restore --artifact-dir ARTIFACT_PATH --confirm-empty-database NAME --report NEW_PATH
          [--unsafe-allow-unauthenticated-activation I_ACCEPT_UNAUTHENTICATED_ARTIFACT]
  retention --backup-root PATH --maximum-age-days DAYS --minimum-retained COUNT --mode dry-run|apply

Environment:
  create: exactly one of SOURCE_DATABASE_URL or DATABASE_URL
  restore: RESTORE_DATABASE_URL
  encryption: exactly one of BACKUP_ENCRYPTION_KEY or BACKUP_ENCRYPTION_KEY_FILE
  tools: PG_DUMP_PATH and PG_RESTORE_PATH (default: pg_dump and pg_restore)`

const PathSchema = z.string().min(1)
const CommandSchema = z.enum(["create", "verify", "restore", "retention"])

export type BackupCommand =
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "create"; readonly artifactDirectory: string }
  | { readonly kind: "verify"; readonly artifactDirectory: string }
  | {
      readonly kind: "restore"
      readonly artifactDirectory: string
      readonly confirmedDatabase: string
      readonly reportPath: string
      readonly allowUnauthenticatedActivation: boolean
    }
  | {
      readonly kind: "retention"
      readonly backupRoot: string
      readonly maximumAgeDays: number
      readonly minimumRetained: number
      readonly mode: "dry-run" | "apply"
    }

export type BackupEnvironment = NodeJS.ProcessEnv & {
  readonly SOURCE_DATABASE_URL?: string
  readonly DATABASE_URL?: string
  readonly RESTORE_DATABASE_URL?: string
  readonly PG_DUMP_PATH?: string
  readonly PG_RESTORE_PATH?: string
  readonly BACKUP_ENCRYPTION_KEY?: string
  readonly BACKUP_ENCRYPTION_KEY_FILE?: string
}

export function parseBackupCommand(
  args: readonly string[],
  _environment: BackupEnvironment,
): BackupCommand {
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    return { kind: "help", text: BACKUP_HELP }
  }
  const command = CommandSchema.parse(args[0])
  if (args.includes("--help")) return { kind: "help", text: BACKUP_HELP }
  const options = parseOptions(args.slice(1))
  switch (command) {
    case "create":
      return {
        kind: "create",
        artifactDirectory: PathSchema.parse(
          exactOptions(options, ["artifact-dir"])["artifact-dir"],
        ),
      }
    case "verify":
      return {
        kind: "verify",
        artifactDirectory: PathSchema.parse(
          exactOptions(options, ["artifact-dir"])["artifact-dir"],
        ),
      }
    case "restore": {
      const parsed = exactOptions(
        options,
        ["artifact-dir", "confirm-empty-database", "report"],
        ["unsafe-allow-unauthenticated-activation"],
      )
      const { report } = parsed
      const acknowledgement = parsed["unsafe-allow-unauthenticated-activation"]
      if (acknowledgement !== undefined) {
        z.literal("I_ACCEPT_UNAUTHENTICATED_ARTIFACT").parse(acknowledgement)
      }
      return {
        kind: "restore",
        artifactDirectory: PathSchema.parse(parsed["artifact-dir"]),
        confirmedDatabase: z.string().min(1).max(63).parse(parsed["confirm-empty-database"]),
        reportPath: PathSchema.parse(report),
        allowUnauthenticatedActivation: acknowledgement !== undefined,
      }
    }
    case "retention": {
      const parsed = exactOptions(options, [
        "backup-root",
        "maximum-age-days",
        "minimum-retained",
        "mode",
      ])
      return {
        kind: "retention",
        backupRoot: PathSchema.parse(parsed["backup-root"]),
        maximumAgeDays: z.coerce.number().int().positive().parse(parsed["maximum-age-days"]),
        minimumRetained: z.coerce.number().int().positive().parse(parsed["minimum-retained"]),
        // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket access
        mode: z.enum(["dry-run", "apply"]).parse(parsed["mode"]),
      }
    }
  }
}

export function sourceDatabaseUrl(environment: BackupEnvironment): string {
  const values = [environment.SOURCE_DATABASE_URL, environment.DATABASE_URL].filter(
    (value): value is string => value !== undefined && value.length > 0,
  )
  if (values.length !== 1) {
    throw backupError("source_database_configuration", "configure exactly one source database URL")
  }
  return values[0] ?? ""
}

export function restoreDatabaseUrl(environment: BackupEnvironment): string {
  const value = environment.RESTORE_DATABASE_URL
  if (value === undefined || value.length === 0) {
    throw backupError("restore_database_configuration", "RESTORE_DATABASE_URL is required")
  }
  return value
}

function parseOptions(args: readonly string[]): Readonly<Record<string, string>> {
  const options: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (
      flag === undefined ||
      !flag.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw backupError("invalid_options", "options must have a value")
    }
    const name = flag.slice(2)
    if (options[name] !== undefined)
      throw backupError("invalid_options", `duplicate option --${name}`)
    options[name] = value
  }
  return options
}

function exactOptions(
  options: Readonly<Record<string, string>>,
  expected: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, string>> {
  for (const name of Object.keys(options)) {
    if (!expected.includes(name) && !optional.includes(name))
      throw backupError("invalid_options", `unknown option --${name}`)
  }
  for (const name of expected) {
    if (options[name] === undefined)
      throw backupError("invalid_options", `missing option --${name}`)
  }
  return options
}
