import { z } from "zod"

const AttemptSchema = z.number().int().positive()

export function retryDelaySeconds(attempt: number): number {
  const parsed = AttemptSchema.parse(attempt)
  return Math.min(2 ** (parsed - 1), 60)
}
