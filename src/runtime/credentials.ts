import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"

export const RunTokenSchema = z.string().regex(/^afwr_[A-Za-z0-9_-]{43}$/)

export function issueRunToken(): string {
  return `afwr_${randomBytes(32).toString("base64url")}`
}

export function isRunToken(value: string): boolean {
  return RunTokenSchema.safeParse(value).success
}

export function runTokenDigest(token: string): Buffer {
  return createHash("sha256").update(RunTokenSchema.parse(token)).digest()
}
