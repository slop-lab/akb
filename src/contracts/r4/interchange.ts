import { z } from "zod"
import { RELATION_TYPES } from "./command-payloads.ts"
import { PRIORITIES, STATE_CATEGORIES } from "./dtos.ts"
import { HumanWorkQuerySchema } from "./query.ts"

const IdSchema = z.string().min(1).max(200)
const DateSchema = z.iso.date().nullable()
const TimestampSchema = z.iso.datetime().nullable()
const BaseRecordSchema = z.strictObject({ externalId: IdSchema })

export const ExportRequestSchema = z
  .strictObject({
    includeArchived: z.boolean().optional().default(false),
    projectId: IdSchema.optional(),
    spaceId: IdSchema.optional(),
  })
  .refine((value) => value.projectId === undefined || value.spaceId === undefined, {
    message: "projectId and spaceId are mutually exclusive",
  })

export const ImportManifestSchema = z.strictObject({
  kind: z.literal("manifest"),
  version: z.literal(1),
  importId: z.string().uuid(),
  workspaceId: IdSchema,
})

const SpaceRecordSchema = BaseRecordSchema.extend({
  kind: z.literal("space"),
  key: z.string().regex(/^[A-Z0-9]{2,10}$/),
  name: z.string().min(1).max(200),
  visibility: z.enum(["public", "private"]).optional(),
  description: z.string().max(10_000).optional(),
  icon: z.string().max(200).nullable().optional(),
  leadId: IdSchema.nullable().optional(),
}).strict()

const WorkflowStateRecordSchema = BaseRecordSchema.extend({
  kind: z.literal("workflow_state"),
  spaceId: IdSchema,
  name: z.string().min(1).max(200),
  category: z.enum(STATE_CATEGORIES),
  color: z.string().min(1).max(64).optional(),
  position: z.number().int().min(0).max(2_147_483_647).optional(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional().default(true),
}).strict()

const ProjectRecordSchema = BaseRecordSchema.extend({
  kind: z.literal("project"),
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(100),
  summary: z.string().max(10_000).optional(),
  ownerId: IdSchema,
  leadIds: z.array(IdSchema).max(20).readonly().optional(),
  participatingSpaceIds: z.array(IdSchema).min(1).max(100).readonly().optional(),
  state: z.enum(["planned", "active", "paused", "completed", "canceled"]).optional(),
  health: z.enum(["on_track", "at_risk", "off_track"]).optional(),
  priority: z.enum(PRIORITIES).optional(),
  startDate: DateSchema.optional(),
  targetDate: DateSchema.optional(),
  completedAt: TimestampSchema.optional(),
  archivedAt: TimestampSchema.optional(),
}).strict()

const LabelRecordSchema = BaseRecordSchema.extend({
  kind: z.literal("label"),
  spaceId: IdSchema,
  name: z.string().min(1).max(200),
  color: z.string().min(1).max(64),
  archivedAt: TimestampSchema.optional(),
}).strict()

const WorkItemRecordSchema = BaseRecordSchema.extend({
  kind: z.literal("work_item"),
  spaceId: IdSchema,
  title: z.string().min(1).max(200),
  ownerId: IdSchema,
  description: z.string().max(20_000).optional(),
  type: z.string().min(1).max(100).optional(),
  priority: z.enum(PRIORITIES).optional(),
  stateId: IdSchema,
  projectId: IdSchema.nullable().optional(),
  labelIds: z.array(IdSchema).max(50).readonly().optional(),
  startDate: DateSchema.optional(),
  dueDate: DateSchema.optional(),
  completedAt: TimestampSchema.optional(),
  archivedAt: TimestampSchema.optional(),
}).strict()

const RelationRecordSchema = BaseRecordSchema.extend({
  kind: z.literal("relation"),
  fromId: IdSchema,
  toId: IdSchema,
  relationType: z.enum(RELATION_TYPES),
  archivedAt: TimestampSchema.optional(),
}).strict()

const CommentRecordSchema = BaseRecordSchema.extend({
  kind: z.literal("comment"),
  subjectId: IdSchema,
  authorId: IdSchema,
  body: z.string().min(1).max(20_000),
  archivedAt: TimestampSchema.optional(),
}).strict()

const SavedViewRecordSchema = BaseRecordSchema.extend({
  kind: z.literal("saved_view"),
  ownerId: IdSchema,
  name: z.string().min(1).max(200),
  access: z.enum(["private", "space", "workspace"]).optional(),
  scopeSpaceId: IdSchema.nullable().optional(),
  definition: HumanWorkQuerySchema,
  archivedAt: TimestampSchema.optional(),
}).strict()

export const ImportRecordSchema = z.discriminatedUnion("kind", [
  ImportManifestSchema,
  SpaceRecordSchema,
  WorkflowStateRecordSchema,
  ProjectRecordSchema,
  LabelRecordSchema,
  WorkItemRecordSchema,
  RelationRecordSchema,
  CommentRecordSchema,
  SavedViewRecordSchema,
])

export const ImportValidationSchema = z.strictObject({
  importId: z.string().uuid(),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  recordCount: z.number().int().positive().max(10_000),
  validationToken: z.string(),
  expiresAt: z.iso.datetime(),
  warnings: z.array(z.string()).readonly().optional(),
})

export const ImportCommitSchema = z.strictObject({
  importId: z.string().uuid(),
  committed: z.literal(true),
  replayed: z.boolean(),
  recordCount: z.number().int().positive(),
})

export type ExportRequest = z.infer<typeof ExportRequestSchema>
export type ImportRecord = z.infer<typeof ImportRecordSchema>
export type ImportValidation = z.infer<typeof ImportValidationSchema>
