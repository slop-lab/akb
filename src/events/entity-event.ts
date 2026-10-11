import { z } from "zod"

export const EntityEventTypeSchema = z.enum([
  "entity.created",
  "entity.updated",
  "entity.archived",
  "entity.restored",
  "acl.changed",
  "relation.created",
  "relation.updated",
  "relation.archived",
  "comment.created",
  "comment.updated",
])

const SemanticDataSchema = z
  .object({
    id: z.string().optional(),
    changedFields: z.array(z.enum(["title", "state"])).optional(),
  })
  .strip()

export const EntityEventSchema = z.strictObject({
  id: z.string(),
  workspaceId: z.string(),
  sequence: z.number().int().positive(),
  type: EntityEventTypeSchema,
  kind: z.string().min(1),
  subjectId: z.string(),
  subjectRevision: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  actorId: z.string().nullable(),
  payloadSchema: z.literal(1),
  data: SemanticDataSchema,
})

const EntityEventRowSchema = z.strictObject({
  id: z.string(),
  workspace_id: z.string(),
  sequence: z.coerce.number().int().positive(),
  event_type: EntityEventTypeSchema,
  subject_kind: z.string().min(1),
  subject_id: z.string(),
  subject_revision: z.coerce.number().int().positive(),
  occurred_at: z.union([z.date(), z.iso.datetime({ offset: true })]),
  actor_id: z.string().nullable(),
  payload_schema: z.coerce.number().pipe(z.literal(1)),
  data: SemanticDataSchema,
})

export type EntityEvent = z.infer<typeof EntityEventSchema>

export function parseEntityEvent(value: unknown): EntityEvent {
  const row = EntityEventRowSchema.parse(value)
  return EntityEventSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    sequence: row.sequence,
    type: row.event_type,
    kind: row.subject_kind,
    subjectId: row.subject_id,
    subjectRevision: row.subject_revision,
    occurredAt:
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : new Date(row.occurred_at).toISOString(),
    actorId: row.actor_id,
    payloadSchema: row.payload_schema,
    data: row.data,
  })
}
