import { z } from "zod"
import type { WorkItemDetail } from "../contracts/r4/dtos.ts"
import { UtcDateTimeSchema } from "./utc-datetime.ts"

const FrozenWorkSchema = z.strictObject({
  id: z.string(),
  work_item_id: z.string(),
  workspace_id: z.string(),
  space_id: z.string(),
  title: z.string(),
  state: z.string(),
  accountable_owner_id: z.string(),
  revision: z.coerce.number().int().positive(),
  created_at: UtcDateTimeSchema,
  updated_at: UtcDateTimeSchema,
  sequence: z.coerce.number().int().positive(),
  workflow_state_id: z.string(),
  project_id: z.string().nullable(),
  description: z.string(),
  item_type: z.string(),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]),
  start_date: z.string().nullable(),
  due_date: z.string().nullable(),
  completed_at: UtcDateTimeSchema.nullable(),
  archived_at: UtcDateTimeSchema.nullable(),
  labelIds: z.array(z.string()).readonly(),
})
const LegacyWorkSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  spaceId: z.string(),
  title: z.string(),
  state: z.string(),
  accountableOwnerId: z.string(),
  revision: z.coerce.number().int().positive(),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
})
const LegacyWorkPmProjectionSchema = z.strictObject({
  _schema: z.literal("legacy-work-pm-query.v1"),
  sequence: z.coerce.number().int().positive(),
  workflow_state_id: z.string(),
  project_id: z.string().nullable(),
  description: z.string(),
  item_type: z.string(),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]),
  start_date: z.string().nullable(),
  due_date: z.string().nullable(),
  completed_at: UtcDateTimeSchema.nullable(),
  archived_at: UtcDateTimeSchema.nullable(),
  labelIds: z.array(z.string()).readonly(),
})
const SourceSchemaVersionSchema = z.enum(["work-item.r4.v1", "work-item.legacy.v1"])
const FrozenWorkRawRowSchema = z.strictObject({
  snapshot_id: z.string().uuid(),
  expires_at: z.string(),
  matched: z.number().int(),
  ordinal: z.number().int(),
  source_revision: z.number().int().positive(),
  source_schema_version: SourceSchemaVersionSchema,
  snapshot: z.record(z.string(), z.unknown()),
  legacy_work_pm_projection: z.record(z.string(), z.unknown()).nullable(),
  space_name: z.string(),
  space_key: z.string(),
  state_name: z.string(),
  state_category: z.enum(["backlog", "unstarted", "started", "completed", "canceled"]),
  state_color: z.string(),
  state_position: z.number().int(),
  owner_name: z.string(),
  project: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
  labels: z.array(z.strictObject({ id: z.string(), name: z.string() })).readonly(),
  parent_id: z.string().nullable(),
  group_key: z.string().nullable(),
})
export type FrozenWorkRow = Omit<z.infer<typeof FrozenWorkRawRowSchema>, "snapshot"> & {
  readonly snapshot: z.infer<typeof FrozenWorkSchema>
}

export function parseFrozenWorkRow(value: unknown): FrozenWorkRow {
  const row = FrozenWorkRawRowSchema.parse(value)
  switch (row.source_schema_version) {
    case "work-item.r4.v1":
      z.null().parse(row.legacy_work_pm_projection)
      return { ...row, snapshot: FrozenWorkSchema.parse(row.snapshot) }
    case "work-item.legacy.v1": {
      const work = LegacyWorkSchema.parse(row.snapshot)
      const projection = LegacyWorkPmProjectionSchema.parse(row.legacy_work_pm_projection)
      return {
        ...row,
        snapshot: FrozenWorkSchema.parse({
          id: work.id,
          work_item_id: work.id,
          workspace_id: work.workspaceId,
          space_id: work.spaceId,
          title: work.title,
          state: work.state,
          accountable_owner_id: work.accountableOwnerId,
          revision: work.revision,
          created_at: work.createdAt,
          updated_at: work.updatedAt,
          sequence: projection.sequence,
          workflow_state_id: projection.workflow_state_id,
          project_id: projection.project_id,
          description: projection.description,
          item_type: projection.item_type,
          priority: projection.priority,
          start_date: projection.start_date,
          due_date: projection.due_date,
          completed_at: projection.completed_at,
          archived_at: projection.archived_at,
          labelIds: projection.labelIds,
        }),
      }
    }
  }
}

export function frozenWorkCard(row: FrozenWorkRow): WorkItemDetail {
  const item = row.snapshot
  return {
    id: item.id,
    workspaceId: item.workspace_id,
    space: { id: item.space_id, name: row.space_name, key: row.space_key },
    key: `${row.space_key}-${item.sequence}`,
    revision: row.source_revision,
    title: item.title,
    description: item.description,
    type: item.item_type,
    workflowState: {
      id: item.workflow_state_id,
      name: row.state_name,
      category: row.state_category,
      color: row.state_color,
      position: row.state_position,
    },
    stateCategory: row.state_category,
    priority: item.priority,
    accountableOwner: { id: item.accountable_owner_id, name: row.owner_name },
    project: row.project,
    labels: row.labels,
    startDate: item.start_date,
    dueDate: item.due_date,
    parentId: row.parent_id,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    completedAt: item.completed_at,
    archivedAt: item.archived_at,
  }
}
