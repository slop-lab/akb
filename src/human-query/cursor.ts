import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"

const CursorBindingSchema = z.strictObject({
  snapshotId: z.string().uuid(),
  ordinal: z.number().int().nonnegative().max(100_000),
  group: z.string().nullable(),
  principalId: z.string(),
  credentialId: z.string(),
  workspaceId: z.string(),
  queryHash: z.string().regex(/^[0-9a-f]{64}$/),
  sortHash: z.string().regex(/^[0-9a-f]{64}$/),
  pageSize: z.number().int().min(1).max(100),
  authorityHash: z.string().regex(/^[0-9a-f]{64}$/),
  authorityEpoch: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
})
export type CursorBinding = z.infer<typeof CursorBindingSchema>

export class InvalidCursorError extends Error {
  override readonly name = "InvalidCursorError"
  constructor() {
    super("invalid cursor")
  }
}

export function encodeCursor(binding: CursorBinding, signingKey: Uint8Array): string {
  requireSigningKey(signingKey)
  const payload = Buffer.from(JSON.stringify(binding)).toString("base64url")
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url")
  return `${payload}.${signature}`
}

export function decodeCursor(cursor: string, signingKey: Uint8Array): CursorBinding {
  requireSigningKey(signingKey)
  const parts = cursor.split(".")
  const payload = parts[0]
  const supplied = parts[1]
  if (parts.length !== 2 || payload === undefined || supplied === undefined) {
    throw new InvalidCursorError()
  }
  const expected = createHmac("sha256", signingKey).update(payload).digest()
  const signature = Buffer.from(supplied, "base64url")
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    throw new InvalidCursorError()
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString())
  } catch (error) {
    if (error instanceof SyntaxError) throw new InvalidCursorError()
    throw error
  }
  const parsed = CursorBindingSchema.safeParse(decoded)
  if (!parsed.success) throw new InvalidCursorError()
  return parsed.data
}

function requireSigningKey(signingKey: Uint8Array): void {
  if (signingKey.byteLength < 32) throw new RangeError("cursor signing key requires 32 bytes")
}
