import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { RuntimeConflictError } from "../runtime/errors.ts"

const CursorSchema = z.strictObject({
  snapshotId: z.uuid(),
  runId: z.string(),
  generation: z.number().int().positive(),
  queryHash: z.string().length(64),
  projection: z.enum(["ref", "card", "detail", "raw"]),
  maxItems: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  ordinal: z.number().int().nonnegative(),
  authorityEpoch: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
})

export type RetrievalCursor = z.infer<typeof CursorSchema>

export function encodeRetrievalCursor(cursor: RetrievalCursor, key: Uint8Array): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url")
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`
}

export function decodeRetrievalCursor(value: string, key: Uint8Array): RetrievalCursor {
  const [payload, signature, extra] = value.split(".")
  if (payload === undefined || signature === undefined || extra !== undefined)
    return invalidCursor()
  const expected = createHmac("sha256", key).update(payload).digest()
  const supplied = Buffer.from(signature, "base64url")
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    return invalidCursor()
  try {
    return CursorSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) return invalidCursor()
    throw error
  }
}

function invalidCursor(): never {
  throw new RuntimeConflictError("cursor_invalid")
}
