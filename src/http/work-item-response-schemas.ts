import { z } from "zod"
import {
  HumanPrincipalIdSchema,
  IsoTimestampSchema,
  RevisionSchema,
  WorkItemIdSchema,
  WorkItemTitleSchema,
  WorkspaceIdSchema,
} from "../work-items/identifiers.ts"
import { WORK_ITEM_STATES } from "../work-items/model.ts"

export const WorkItemSchema = z.strictObject({
  id: WorkItemIdSchema,
  workspaceId: WorkspaceIdSchema,
  title: WorkItemTitleSchema,
  state: z.enum(WORK_ITEM_STATES),
  accountableOwnerId: HumanPrincipalIdSchema,
  revision: RevisionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
})

export const WorkItemEnvelopeSchema = z.strictObject({ item: WorkItemSchema })

export const WorkItemCardSchema = z.strictObject({
  id: WorkItemIdSchema,
  kind: z.literal("work_item"),
  title: WorkItemTitleSchema,
  revision: RevisionSchema,
  state: z.enum(WORK_ITEM_STATES),
  accountableOwnerId: HumanPrincipalIdSchema,
  estimatedTokens: z.number().int().nonnegative(),
})
export type WorkItemCard = z.infer<typeof WorkItemCardSchema>

export const ListCompletenessSchema = z.strictObject({
  returned: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  truncated: z.boolean(),
})

export const ListOmissionSchema = z.strictObject({
  category: z.literal("work_item"),
  count: z.number().int().positive(),
  reason: z.literal("budget"),
})

export const WorkItemListSchema = z.strictObject({
  items: z.array(WorkItemCardSchema).max(100),
  completeness: ListCompletenessSchema,
  omitted: z.array(ListOmissionSchema),
  nextCursor: z.null(),
  estimatedTokens: z.number().int().nonnegative(),
})

export const HealthResponseSchema = z.strictObject({ status: z.literal("ok") })
