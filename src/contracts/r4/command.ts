import { z } from "zod"
import { RawIdempotencyKeySchema } from "../../work-items/identifiers.ts"
import { CommandIdSchema, R4RevisionSchema } from "./identifiers.ts"

export const CommandPayloadSchema = z.record(z.string(), z.unknown())
export const CommandEnvelopeSchema = z.strictObject({
  commandId: CommandIdSchema,
  idempotencyKey: RawIdempotencyKeySchema,
  baseRevision: R4RevisionSchema.nullable(),
  payload: CommandPayloadSchema,
})
export const CommandResultSchema = z.strictObject({
  commandId: CommandIdSchema,
  eventId: z.string().min(1).nullable(),
  result: z.record(z.string(), z.unknown()),
  revision: R4RevisionSchema,
  replayed: z.boolean(),
  warnings: z.array(z.string()).readonly(),
})

export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>
export type CommandResult = z.infer<typeof CommandResultSchema>
