import { z } from "zod"

function rawSemanticString(maxLength: number) {
  return z
    .string()
    .min(1)
    .regex(/\S/)
    .refine((value) => Array.from(value).length <= maxLength, {
      message: `Too big: expected string to have <=${maxLength} characters`,
    })
    .meta({ maxLength })
}

const rawSemanticId = rawSemanticString(128)

export const RawWorkspaceIdSchema = rawSemanticId
export const RawSpaceIdSchema = rawSemanticId
export const RawWorkItemIdSchema = rawSemanticId
export const RawHumanPrincipalIdSchema = rawSemanticId
export const RawActorIdSchema = rawSemanticId
export const RawEventIdSchema = rawSemanticId
export const WorkspaceIdSchema = RawWorkspaceIdSchema.transform((value) => value.trim()).brand(
  "WorkspaceId",
)
export const SpaceIdSchema = RawSpaceIdSchema.transform((value) => value.trim()).brand("SpaceId")
export const WorkItemIdSchema = RawWorkItemIdSchema.transform((value) => value.trim()).brand(
  "WorkItemId",
)
export const HumanPrincipalIdSchema = RawHumanPrincipalIdSchema.transform((value) =>
  value.trim(),
).brand("HumanPrincipalId")
export const ActorIdSchema = RawActorIdSchema.transform((value) => value.trim()).brand("ActorId")
export const EventIdSchema = RawEventIdSchema.transform((value) => value.trim()).brand("EventId")
export const RawIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[!-~]+$/)
export const IdempotencyKeySchema = RawIdempotencyKeySchema.brand("IdempotencyKey")
export const RevisionSchema = z.number().int().min(1).brand("Revision")
export const RawWorkItemTitleSchema = rawSemanticString(200)
export const WorkItemTitleSchema = RawWorkItemTitleSchema.transform((value) => value.trim()).brand(
  "WorkItemTitle",
)
export const IsoTimestampSchema = z.iso.datetime()

export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>
export type SpaceId = z.infer<typeof SpaceIdSchema>
export type WorkItemId = z.infer<typeof WorkItemIdSchema>
export type HumanPrincipalId = z.infer<typeof HumanPrincipalIdSchema>
export type ActorId = z.infer<typeof ActorIdSchema>
export type EventId = z.infer<typeof EventIdSchema>
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>
export type Revision = z.infer<typeof RevisionSchema>
export type WorkItemTitle = z.infer<typeof WorkItemTitleSchema>

export const workspaceId = (value: string): WorkspaceId => WorkspaceIdSchema.parse(value)
export const spaceId = (value: string): SpaceId => SpaceIdSchema.parse(value)
export const workItemId = (value: string): WorkItemId => WorkItemIdSchema.parse(value)
export const humanPrincipalId = (value: string): HumanPrincipalId =>
  HumanPrincipalIdSchema.parse(value)
export const actorId = (value: string): ActorId => ActorIdSchema.parse(value)
export const eventId = (value: string): EventId => EventIdSchema.parse(value)
export const idempotencyKey = (value: string): IdempotencyKey => IdempotencyKeySchema.parse(value)
export const revision = (value: number): Revision => RevisionSchema.parse(value)
export const workItemTitle = (value: string): WorkItemTitle => WorkItemTitleSchema.parse(value)
