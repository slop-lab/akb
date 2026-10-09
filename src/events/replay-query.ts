import { z } from "zod"

const canonicalDecimal = (maximum: number) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(maximum))

export const ReplayQuerySchema = z.strictObject({
  after: canonicalDecimal(Number.MAX_SAFE_INTEGER),
  limit: canonicalDecimal(100).pipe(z.number().min(1)),
})
