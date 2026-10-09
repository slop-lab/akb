export const EXPECTED_MIGRATIONS = [
  "001_work_item_persistence.sql",
  "002_workspace_identity.sql",
  "003_transactional_outbox.sql",
  "004_space_acl.sql",
] as const

export const TABLES = [
  { name: "workspace_event_sequences", order: [{ column: "workspace_id", kind: "text" }] },
  { name: "work_items", order: [{ column: "id", kind: "text" }] },
  {
    name: "work_item_revisions",
    order: [
      { column: "work_item_id", kind: "text" },
      { column: "revision", kind: "numeric" },
    ],
  },
  { name: "domain_events", order: [{ column: "id", kind: "text" }] },
  {
    name: "work_item_idempotency",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "idempotency_key", kind: "text" },
    ],
  },
  { name: "workspaces", order: [{ column: "id", kind: "text" }] },
  { name: "principals", order: [{ column: "id", kind: "text" }] },
  {
    name: "workspace_memberships",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "principal_id", kind: "text" },
    ],
  },
  {
    name: "membership_permissions",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "principal_id", kind: "text" },
      { column: "permission", kind: "text" },
    ],
  },
  { name: "principal_credentials", order: [{ column: "id", kind: "text" }] },
  { name: "outbox_events", order: [{ column: "event_id", kind: "text" }] },
  {
    name: "outbox_destinations",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "destination_id", kind: "text" },
    ],
  },
  {
    name: "outbox_jobs",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "destination_id", kind: "text" },
      { column: "event_id", kind: "text" },
    ],
  },
  {
    name: "delivery_inbox",
    order: [
      { column: "destination_id", kind: "text" },
      { column: "event_id", kind: "text" },
    ],
  },
  {
    name: "spaces",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "id", kind: "text" },
    ],
  },
  {
    name: "space_permissions",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "space_id", kind: "text" },
      { column: "principal_id", kind: "text" },
      { column: "permission", kind: "text" },
    ],
  },
] as const

export const ALL_TABLE_NAMES = ["schema_migrations", ...TABLES.map((table) => table.name)] as const
export const ARTIFACT_FILES = ["archive.dump", "manifest.json"] as const
export const POSTGRES_MAJOR = 17
