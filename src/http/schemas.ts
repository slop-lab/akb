import { z } from "zod"
import {
  ActorIdSchema,
  HumanPrincipalIdSchema,
  IdempotencyKeySchema,
  RawActorIdSchema,
  RawHumanPrincipalIdSchema,
  RawWorkItemIdSchema,
  RawWorkItemTitleSchema,
  RawWorkspaceIdSchema,
  RevisionSchema,
  WorkItemTitleSchema,
} from "../work-items/identifiers.ts"
import { WORK_ITEM_STATES } from "../work-items/model.ts"
import { RawPathSegmentSchema } from "./path-segment.ts"

export const RawCreateWorkItemBodySchema = z.strictObject({
  title: RawWorkItemTitleSchema,
  accountableOwnerId: RawHumanPrincipalIdSchema,
  actorId: RawActorIdSchema.meta({ deprecated: true }),
})

export const CreateWorkItemBodySchema = z.strictObject({
  title: WorkItemTitleSchema,
  accountableOwnerId: HumanPrincipalIdSchema,
  actorId: ActorIdSchema.meta({ deprecated: true }),
})

export const RawPatchWorkItemBodySchema = z
  .strictObject({
    actorId: RawActorIdSchema.meta({ deprecated: true }),
    baseRevision: RevisionSchema,
    title: RawWorkItemTitleSchema.optional(),
    state: z.enum(WORK_ITEM_STATES).optional(),
  })
  .refine((body) => body.title !== undefined || body.state !== undefined, {
    message: "at least one of title or state is required",
  })

export const PatchWorkItemBodySchema = z
  .strictObject({
    actorId: ActorIdSchema.meta({ deprecated: true }),
    baseRevision: RevisionSchema,
    title: WorkItemTitleSchema.optional(),
    state: z.enum(WORK_ITEM_STATES).optional(),
  })
  .refine((body) => body.title !== undefined || body.state !== undefined, {
    message: "at least one of title or state is required",
  })

export const RawWorkspacePathSchema = RawPathSegmentSchema.and(RawWorkspaceIdSchema)
export const RawWorkItemPathSchema = RawPathSegmentSchema.and(RawWorkItemIdSchema)
export const WorkspacePathSchema = RawWorkspacePathSchema.transform((value) => value.trim()).brand(
  "WorkspaceId",
)
export const WorkItemPathSchema = RawWorkItemPathSchema.transform((value) => value.trim()).brand(
  "WorkItemId",
)
export const IdempotencyHeaderSchema = IdempotencyKeySchema

export type CreateWorkItemBody = z.infer<typeof CreateWorkItemBodySchema>
export type PatchWorkItemBody = z.infer<typeof PatchWorkItemBodySchema>
