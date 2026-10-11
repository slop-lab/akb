export type TableResource = {
  readonly name: string
  readonly order: readonly {
    readonly column: string
    readonly kind: "text" | "numeric"
  }[]
}

export const SCHEMA_004_TABLES = [
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
] as const satisfies readonly TableResource[]

export const SCHEMA_008_TABLES = [
  ...SCHEMA_004_TABLES,
  { name: "permission_atoms", order: [{ column: "permission", kind: "text" }] },
  { name: "workspace_authority_epochs", order: [{ column: "workspace_id", kind: "text" }] },
  { name: "entities", order: [{ column: "id", kind: "text" }] },
  {
    name: "entity_revisions",
    order: [
      { column: "entity_id", kind: "text" },
      { column: "revision", kind: "numeric" },
    ],
  },
  { name: "entity_acl_policies", order: [{ column: "entity_id", kind: "text" }] },
  {
    name: "entity_acl_allowances",
    order: [
      { column: "entity_id", kind: "text" },
      { column: "principal_id", kind: "text" },
      { column: "permission", kind: "text" },
    ],
  },
  { name: "entity_event_sequences", order: [{ column: "workspace_id", kind: "text" }] },
  { name: "entity_events_v1", order: [{ column: "id", kind: "text" }] },
  { name: "entity_outbox_events_v1", order: [{ column: "event_id", kind: "text" }] },
  {
    name: "entity_outbox_destinations_v1",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "destination_id", kind: "text" },
    ],
  },
  {
    name: "entity_outbox_jobs_v1",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "destination_id", kind: "text" },
      { column: "event_id", kind: "text" },
    ],
  },
  {
    name: "delivery_inbox_v1",
    order: [
      { column: "destination_id", kind: "text" },
      { column: "event_id", kind: "text" },
    ],
  },
  {
    name: "generic_command_idempotency",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "idempotency_key", kind: "text" },
    ],
  },
  {
    name: "space_details",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "space_id", kind: "text" },
    ],
  },
  {
    name: "space_work_sequences",
    order: [
      { column: "workspace_id", kind: "text" },
      { column: "space_id", kind: "text" },
    ],
  },
  { name: "workflows", order: [{ column: "id", kind: "text" }] },
  { name: "workflow_states", order: [{ column: "id", kind: "text" }] },
  { name: "projects", order: [{ column: "id", kind: "text" }] },
  {
    name: "project_spaces",
    order: [
      { column: "project_id", kind: "text" },
      { column: "space_id", kind: "text" },
    ],
  },
  { name: "work_item_pm", order: [{ column: "work_item_id", kind: "text" }] },
  { name: "labels", order: [{ column: "id", kind: "text" }] },
  {
    name: "work_item_labels",
    order: [
      { column: "work_item_id", kind: "text" },
      { column: "label_id", kind: "text" },
    ],
  },
  { name: "relations", order: [{ column: "id", kind: "text" }] },
  { name: "threads", order: [{ column: "id", kind: "text" }] },
  { name: "comments", order: [{ column: "id", kind: "text" }] },
  { name: "saved_views", order: [{ column: "id", kind: "text" }] },
  { name: "search_documents", order: [{ column: "entity_id", kind: "text" }] },
  { name: "human_query_snapshots", order: [{ column: "id", kind: "text" }] },
  {
    name: "human_query_snapshot_items",
    order: [
      { column: "snapshot_id", kind: "text" },
      { column: "ordinal", kind: "numeric" },
    ],
  },
  { name: "import_batches", order: [{ column: "import_id", kind: "text" }] },
  {
    name: "import_record_ids",
    order: [
      { column: "import_id", kind: "text" },
      { column: "external_id", kind: "text" },
    ],
  },
  { name: "retention_policies", order: [{ column: "resource", kind: "text" }] },
] as const satisfies readonly TableResource[]
