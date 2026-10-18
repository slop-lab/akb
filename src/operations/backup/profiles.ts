import type { TableResource } from "./resources.ts"
import {
  SCHEMA_004_TABLES,
  SCHEMA_008_TABLES,
  SCHEMA_009_TABLES,
  SCHEMA_010_TABLES,
} from "./resources.ts"
import { SCHEMA_016_ADDITIONAL_TABLES } from "./resources-r8.ts"

export const SCHEMA_004_MIGRATIONS = [
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
] as const

export const SCHEMA_008_MIGRATIONS = [
  ...SCHEMA_004_MIGRATIONS,
  {
    name: "005_entity_registry_acl.sql",
    checksum: "378baa0b0c42c9d7fea369dbaaeae2eaa11f00cceb7db4bfea1e8b06f4553121",
  },
  {
    name: "006_entity_event_outbox.sql",
    checksum: "ae5b3e9b9832c5c3bdb420d81378694d85caf1af9d1733eceb80a64ed79f9052",
  },
  {
    name: "007_r4_pm_core.sql",
    checksum: "48cc1389f874dbc56261ec5b7c38a39efa3fa2b15a0ef4d07972f00d8eda8b6b",
  },
  {
    name: "008_human_query_import_retention.sql",
    checksum: "6af95983b4d899c73a5ca9608480676e54a711ffbc14a87895ed624abe6750e4",
  },
] as const

export const SCHEMA_009_MIGRATIONS = [
  ...SCHEMA_008_MIGRATIONS,
  {
    name: "009_legacy_workflow_revision_history.sql",
    checksum: "fb962024d4c2045cbb72dfaccf6bed4a3ff95383800a8303b4c8427b8060fbd4",
  },
] as const

export const SCHEMA_010_MIGRATIONS = [
  ...SCHEMA_009_MIGRATIONS,
  {
    name: "010_legacy_work_query_projection.sql",
    checksum: "88c1308455b0b790aed2a07d8294f72701c73857faccda3a3ea62f4bc6b21a04",
  },
] as const

export const SCHEMA_016_MIGRATIONS = [
  ...SCHEMA_010_MIGRATIONS,
  {
    name: "011_feature_foundation.sql",
    checksum: "4c7799f94d5d3f572d5e4006ea5a1ed2ce8b06a894630a94ec9524cda9e32baf",
  },
  {
    name: "012_planning.sql",
    checksum: "b086955644f6b0fb7bd8d772b4727f29daf2cc96083c38c6b6a1c02ebbc0d6f5",
  },
  {
    name: "013_content.sql",
    checksum: "817eed79ad5279bda2083b92e340e0e0f64ef4a01f8b13adcca105c2cb3a7b1f",
  },
  {
    name: "014_runtime.sql",
    checksum: "2a3b95548084f2179ef1cf72f0e398e3c967b1e058ec38007fe0d35446b8f3e6",
  },
  {
    name: "015_knowledge.sql",
    checksum: "7b9aeab31e5485f8864121578ac9325d87cb9f3b2127df5efbe348aaabd5ec79",
  },
  {
    name: "016_automation.sql",
    checksum: "d4381bb1fcda3ccee51d4b058c017830386b6a7e5509996d7b60b3e6dae1e24d",
  },
] as const

export const SCHEMA_004_FINGERPRINT =
  "9779ac0afb4287e3453a658daca57f10ebb3cd7e37d9bb77521526a08e1192eb"
export const SCHEMA_008_FINGERPRINT =
  "9ee67a3a89d8cf7f47c93ab0136b0c93f00bc605e40f539d7afa5d4bd0ee6242"
export const SCHEMA_009_FINGERPRINT = SCHEMA_008_FINGERPRINT
export const SCHEMA_010_FINGERPRINT =
  "1002d3c51bc4984a8cd4fbc9aadb56e3a7241adcb4f6149a5bd2615cb05eddac"
export const SCHEMA_016_FINGERPRINT =
  "3f9e29ddb69d8e3d5d5b0a7108eebdf3f84e8be3da367d1cc9bbbe1aa2e9230b"
export const SCHEMA_016_TABLES = [...SCHEMA_010_TABLES, ...SCHEMA_016_ADDITIONAL_TABLES] as const

export type BackupProfile = {
  readonly id:
    | "r3-schema-004-public"
    | "r4-schema-008-public-v1"
    | "r4-schema-009-public-v1"
    | "r4-schema-010-public-v1"
    | "r8-schema-016-public-v1"
  readonly finalMigration:
    | "004_space_acl.sql"
    | "008_human_query_import_retention.sql"
    | "009_legacy_workflow_revision_history.sql"
    | "010_legacy_work_query_projection.sql"
    | "016_automation.sql"
  readonly migrations: readonly { readonly name: string; readonly checksum: string }[]
  readonly tables: readonly TableResource[]
  readonly schemaFingerprint: string
}

export const PROFILE_004: BackupProfile = Object.freeze({
  id: "r3-schema-004-public",
  finalMigration: "004_space_acl.sql",
  migrations: SCHEMA_004_MIGRATIONS,
  tables: SCHEMA_004_TABLES,
  schemaFingerprint: SCHEMA_004_FINGERPRINT,
})

export const PROFILE_008: BackupProfile = Object.freeze({
  id: "r4-schema-008-public-v1",
  finalMigration: "008_human_query_import_retention.sql",
  migrations: SCHEMA_008_MIGRATIONS,
  tables: SCHEMA_008_TABLES,
  schemaFingerprint: SCHEMA_008_FINGERPRINT,
})

export const PROFILE_009: BackupProfile = Object.freeze({
  id: "r4-schema-009-public-v1",
  finalMigration: "009_legacy_workflow_revision_history.sql",
  migrations: SCHEMA_009_MIGRATIONS,
  tables: SCHEMA_009_TABLES,
  schemaFingerprint: SCHEMA_009_FINGERPRINT,
})

export const PROFILE_010: BackupProfile = Object.freeze({
  id: "r4-schema-010-public-v1",
  finalMigration: "010_legacy_work_query_projection.sql",
  migrations: SCHEMA_010_MIGRATIONS,
  tables: SCHEMA_010_TABLES,
  schemaFingerprint: SCHEMA_010_FINGERPRINT,
})

export const PROFILE_016: BackupProfile = Object.freeze({
  id: "r8-schema-016-public-v1",
  finalMigration: "016_automation.sql",
  migrations: SCHEMA_016_MIGRATIONS,
  tables: SCHEMA_016_TABLES,
  schemaFingerprint: SCHEMA_016_FINGERPRINT,
})

export function profileFromLedger(
  ledger: readonly { readonly name: string; readonly checksum: string }[],
): BackupProfile {
  if (JSON.stringify(ledger) === JSON.stringify(PROFILE_004.migrations)) return PROFILE_004
  if (JSON.stringify(ledger) === JSON.stringify(PROFILE_008.migrations)) return PROFILE_008
  if (JSON.stringify(ledger) === JSON.stringify(PROFILE_009.migrations)) return PROFILE_009
  if (JSON.stringify(ledger) === JSON.stringify(PROFILE_010.migrations)) return PROFILE_010
  if (JSON.stringify(ledger) === JSON.stringify(PROFILE_016.migrations)) return PROFILE_016
  throw new TypeError("database migration ledger has no registered backup profile")
}

export function profileFromId(id: BackupProfile["id"]): BackupProfile {
  switch (id) {
    case "r3-schema-004-public":
      return PROFILE_004
    case "r4-schema-008-public-v1":
      return PROFILE_008
    case "r4-schema-009-public-v1":
      return PROFILE_009
    case "r4-schema-010-public-v1":
      return PROFILE_010
    case "r8-schema-016-public-v1":
      return PROFILE_016
  }
}
