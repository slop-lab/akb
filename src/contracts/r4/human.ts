import { z } from "zod"
import {
  ProjectSchema,
  STATE_CATEGORIES,
  WorkItemCardSchema,
  WorkItemDetailSchema,
} from "./dtos.ts"
import { HumanWorkQuerySchema, QuerySnapshotSchema } from "./query.ts"

const EntityRefSchema = z.strictObject({ id: z.string(), name: z.string() })
export const SpaceSchema = z.strictObject({
  id: z.string(),
  entityId: z.string(),
  revision: z.number().int().positive(),
  name: z.string(),
  key: z.string(),
  icon: z.string().nullable(),
  description: z.string(),
  visibility: z.enum(["public", "private"]),
  lead: EntityRefSchema.nullable(),
})
export const WorkflowStateConfigSchema = z.strictObject({
  id: z.string(),
  revision: z.number().int().positive(),
  name: z.string(),
  category: z.enum(STATE_CATEGORIES),
  color: z.string(),
  position: z.number().int().nonnegative(),
  isDefault: z.boolean(),
})
export const SpaceConfigSchema = z.strictObject({
  space: SpaceSchema,
  workflow: z.strictObject({
    id: z.string(),
    name: z.string(),
    revision: z.number().int().positive(),
    states: z.array(WorkflowStateConfigSchema).readonly(),
  }),
  labels: z
    .array(
      EntityRefSchema.extend({ color: z.string(), revision: z.number().int().positive() }).strict(),
    )
    .readonly(),
})
export const BootstrapSchema = z.strictObject({
  workspace: EntityRefSchema,
  principal: EntityRefSchema.extend({ kind: z.literal("human") }).strict(),
  permissions: z.array(z.string()).readonly(),
  principals: z.array(EntityRefSchema).readonly(),
  spaces: z.array(SpaceSchema).readonly(),
  currentSpaceId: z.string().nullable(),
})
export const HistoryEntrySchema = z.strictObject({
  revision: z.number().int().positive(),
  schemaVersion: z.string(),
  snapshot: z.record(z.string(), z.unknown()),
  actor: EntityRefSchema.nullable(),
  createdAt: z.iso.datetime(),
})
export const RelationSchema = z.strictObject({
  id: z.string(),
  relationType: z.string(),
  from: EntityRefSchema,
  to: EntityRefSchema,
  revision: z.number().int().positive(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
})
export const CommentSchema = z.strictObject({
  id: z.string(),
  subjectId: z.string(),
  author: EntityRefSchema,
  body: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
})
export const SavedViewSchema = z.strictObject({
  id: z.string(),
  owner: EntityRefSchema,
  name: z.string(),
  access: z.enum(["private", "space", "workspace"]),
  scopeSpaceId: z.string().nullable(),
  definition: HumanWorkQuerySchema,
  revision: z.number().int().positive(),
  archivedAt: z.iso.datetime().nullable(),
})
export const ProjectQuerySchema = HumanWorkQuerySchema.omit({ model: true }).extend({
  page: z.strictObject({ size: z.number().int().min(1).max(100), cursor: z.string().nullable() }),
})
export const ProjectPageSchema = z.strictObject({
  snapshot: QuerySnapshotSchema,
  items: z.array(ProjectSchema).readonly(),
  matched: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
})
export const BoardRequestSchema = HumanWorkQuerySchema.extend({
  workflowStateId: z.string().nullable(),
  page: z.strictObject({ size: z.number().int().min(1).max(25), cursor: z.string().nullable() }),
}).superRefine((request, context) => {
  if ((request.page.cursor === null) !== (request.workflowStateId === null)) {
    context.addIssue({
      code: "custom",
      message: "workflowStateId is required exactly when continuing a board column",
    })
  }
})
export const BoardSchema = z.strictObject({
  snapshot: QuerySnapshotSchema,
  columns: z
    .array(
      z.strictObject({
        state: WorkflowStateConfigSchema,
        total: z.number().int().nonnegative(),
        cards: z.array(WorkItemCardSchema).readonly(),
        nextCursor: z.string().nullable(),
      }),
    )
    .readonly(),
})
export const SearchRequestSchema = z.strictObject({
  text: z.string().min(1).max(500),
  kinds: z
    .array(z.enum(["project", "work_item", "comment"]))
    .min(1)
    .max(3)
    .readonly(),
  limit: z.number().int().min(1).max(100),
})
export const SearchResultSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["project", "work_item", "comment"]),
  title: z.string(),
  sourceRevision: z.number().int().positive(),
})
export const WorkDetailResponseSchema = z.strictObject({ item: WorkItemDetailSchema })

export type Bootstrap = z.infer<typeof BootstrapSchema>
export type Space = z.infer<typeof SpaceSchema>
export type SpaceConfig = z.infer<typeof SpaceConfigSchema>
export type Relation = z.infer<typeof RelationSchema>
export type Comment = z.infer<typeof CommentSchema>
export type SavedView = z.infer<typeof SavedViewSchema>
export type ProjectQuery = z.infer<typeof ProjectQuerySchema>
export type ProjectPage = z.infer<typeof ProjectPageSchema>
export type BoardRequest = z.infer<typeof BoardRequestSchema>
export type Board = z.infer<typeof BoardSchema>
