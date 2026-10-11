import { PROFILE_004 } from "./profiles.ts"
import { SCHEMA_004_TABLES } from "./resources.ts"

export const EXPECTED_MIGRATIONS = PROFILE_004.migrations.map(({ name }) => name)
export const TABLES = SCHEMA_004_TABLES

export const ALL_TABLE_NAMES = ["schema_migrations", ...TABLES.map((table) => table.name)] as const
export const ARTIFACT_FILES = ["archive.dump", "manifest.json"] as const
export const POSTGRES_MAJOR = 17
