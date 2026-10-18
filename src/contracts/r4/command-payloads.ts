import { z } from "zod"
import { R4WorkPermissionSchema } from "../../identity/types.ts"
import { PRIORITIES, STATE_CATEGORIES } from "./dtos.ts"
import { HumanWorkQuerySchema } from "./query.ts"

const IdSchema = z.string().trim().min(1).max(200)
const NameSchema = z.string().trim().min(1).max(200)
const ColorSchema = z.string().trim().min(1).max(64)
const NullableIdSchema = IdSchema.nullable()
const DateSchema = z.iso.date().nullable()
const PrioritySchema = z.enum(PRIORITIES)
const dateOrder = (start: string | null | undefined, end: string | null | undefined) =>
  start === null || start === undefined || end === null || end === undefined || start <= end

export const SpaceCreatePayloadSchema = z.strictObject({
  id: IdSchema,
  key: z.string().regex(/^[A-Z0-9]{2,10}$/),
  name: NameSchema,
  visibility: z.enum(["public", "private"]),
  description: z.string().max(10_000),
  icon: z.string().max(200).nullable(),
  leadId: NullableIdSchema,
})
export const SpaceUpdatePayloadSchema = z.strictObject({
  name: NameSchema.optional(),
  visibility: z.enum(["public", "private"]).optional(),
  description: z.string().max(10_000).optional(),
  icon: z.string().max(200).nullable().optional(),
  leadId: NullableIdSchema.optional(),
})
export const SpaceAccessPayloadSchema = z.strictObject({
  principalId: IdSchema,
  permissions: z.array(R4WorkPermissionSchema).max(15).readonly(),
})
export const WorkflowUpdatePayloadSchema = z.strictObject({ name: NameSchema })
export const WorkflowStateCreatePayloadSchema = z.strictObject({
  name: NameSchema,
  category: z.enum(STATE_CATEGORIES),
  color: ColorSchema,
  position: z.number().int().min(0).max(19),
  isDefault: z.boolean(),
})
export const WorkflowStateUpdatePayloadSchema = z.strictObject({
  name: NameSchema.optional(),
  color: ColorSchema.optional(),
  position: z.number().int().min(0).max(19).optional(),
  isDefault: z.boolean().optional(),
})
export const ArchivePayloadSchema = z.strictObject({})
export const LabelCreatePayloadSchema = z.strictObject({ name: NameSchema, color: ColorSchema })
export const LabelUpdatePayloadSchema = z.strictObject({
  name: NameSchema.optional(),
  color: ColorSchema.optional(),
})

const ProjectFieldsSchema = z.strictObject({
  name: NameSchema,
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  summary: z.string().max(10_000),
  ownerId: IdSchema,
  leadIds: z.array(IdSchema).max(20).readonly(),
  participatingSpaceIds: z.array(IdSchema).min(1).max(100).readonly(),
  state: z.enum(["planned", "active", "paused", "completed", "canceled"]),
  health: z.enum(["on_track", "at_risk", "off_track"]),
  priority: PrioritySchema,
  startDate: DateSchema,
  targetDate: DateSchema,
})
export const ProjectCreatePayloadSchema = ProjectFieldsSchema.refine(
  (value) => dateOrder(value.startDate, value.targetDate),
  { path: ["targetDate"], message: "target date must not precede start date" },
)
export const ProjectUpdatePayloadSchema = ProjectFieldsSchema.partial().refine(
  (value) => dateOrder(value.startDate, value.targetDate),
  { path: ["targetDate"], message: "target date must not precede start date" },
)

const WorkFieldsSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  accountableOwnerId: IdSchema,
  description: z.string().max(20_000),
  type: z.string().trim().min(1).max(100),
  workflowStateId: IdSchema,
  projectId: NullableIdSchema,
  priority: PrioritySchema,
  labelIds: z.array(IdSchema).max(50).readonly(),
  startDate: DateSchema,
  dueDate: DateSchema,
})
export const WorkItemCreatePayloadSchema = WorkFieldsSchema.extend({ spaceId: IdSchema })
  .strict()
  .refine((value) => dateOrder(value.startDate, value.dueDate), {
    path: ["dueDate"],
    message: "due date must not precede start date",
  })
export const WorkItemUpdatePayloadSchema = WorkFieldsSchema.partial().refine(
  (value) => dateOrder(value.startDate, value.dueDate),
  { path: ["dueDate"], message: "due date must not precede start date" },
)

export const RELATION_TYPES = [
  "parent_of",
  "blocks",
  "related_to",
  "duplicates",
  "implements",
  "verifies",
  "supports",
  "contradicts",
  "supersedes",
  "generated_by",
] as const
export const RelationCreatePayloadSchema = z
  .strictObject({
    fromEntityId: IdSchema,
    relationType: z.enum(RELATION_TYPES),
    toEntityId: IdSchema,
  })
  .refine((value) => value.fromEntityId !== value.toEntityId, {
    path: ["toEntityId"],
    message: "relation endpoints must differ",
  })
  .refine((value) => value.relationType !== "related_to" || value.fromEntityId < value.toEntityId, {
    path: ["toEntityId"],
    message: "related_to endpoints must be canonically ordered",
  })
export const RelationUpdatePayloadSchema = z.strictObject({
  relationType: z.enum(RELATION_TYPES),
})
export const CommentCreatePayloadSchema = z.strictObject({
  body: z.string().min(1).max(20_000),
})
export const CommentUpdatePayloadSchema = CommentCreatePayloadSchema

const SavedViewDefinitionSchema = HumanWorkQuerySchema.refine(
  (definition) => definition.page.cursor === null,
  { path: ["page", "cursor"], message: "Saved View cursor must be null" },
)
export const SavedViewCreatePayloadSchema = z.strictObject({
  name: NameSchema,
  access: z.enum(["private", "space", "workspace"]),
  scopeSpaceId: NullableIdSchema,
  definition: SavedViewDefinitionSchema,
})
export const SavedViewUpdatePayloadSchema = SavedViewCreatePayloadSchema.partial()

export const EntityAccessPayloadSchema = z
  .strictObject({
    mode: z.enum(["inherit", "restricted"]),
    allowances: z
      .array(
        z.strictObject({
          principalId: IdSchema,
          permissions: z.array(R4WorkPermissionSchema).min(1).max(15).readonly(),
        }),
      )
      .max(100)
      .readonly(),
  })
  .refine((value) => value.mode === "restricted" || value.allowances.length === 0, {
    path: ["allowances"],
    message: "inherit policy cannot contain allowances",
  })
  .refine((value) => value.mode === "inherit" || value.allowances.length > 0, {
    path: ["allowances"],
    message: "restricted policy requires allowances",
  })

export type SpaceCreatePayload = z.infer<typeof SpaceCreatePayloadSchema>
export type ProjectCreatePayload = z.infer<typeof ProjectCreatePayloadSchema>
export type WorkItemCreatePayload = z.infer<typeof WorkItemCreatePayloadSchema>
