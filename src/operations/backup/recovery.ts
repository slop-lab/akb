import { z } from "zod"
import { backupError } from "./errors.ts"
import { sha256 } from "./manifest.ts"

const QuarantineAssertionsSchema = z.strictObject({
  activeCredentials: z.literal(0),
  leasedJobs: z.literal(0),
})
const QuarantineAssertionsV2Schema = QuarantineAssertionsSchema.extend({
  genericLeasedJobs: z.literal(0),
})

export type QuarantineAssertions = z.infer<typeof QuarantineAssertionsSchema>
export type QuarantineAssertionsV2 = z.infer<typeof QuarantineAssertionsV2Schema>

export function quarantineAssertions(value: {
  readonly activeCredentials: number
  readonly leasedJobs: number
}): QuarantineAssertions
export function quarantineAssertions(value: {
  readonly activeCredentials: number
  readonly leasedJobs: number
  readonly genericLeasedJobs: number
}): QuarantineAssertionsV2
export function quarantineAssertions(value: {
  readonly activeCredentials: number
  readonly leasedJobs: number
  readonly genericLeasedJobs?: number
}): QuarantineAssertions | QuarantineAssertionsV2 {
  const parsed = (
    value.genericLeasedJobs === undefined
      ? QuarantineAssertionsSchema
      : QuarantineAssertionsV2Schema
  ).safeParse(value)
  if (!parsed.success) {
    throw backupError(
      "quarantine_failed",
      "active credentials or leased jobs remain after recovery",
    )
  }
  return parsed.data
}

export function computeRecoveryOutcomeDigestV2(input: object): string {
  return sha256(JSON.stringify({ quarantinePolicyVersion: 2, ...input }))
}

export function computeRecoveryOutcomeDigest(input: {
  readonly sourceOverallDigest: string
  readonly schemaFingerprint: string
  readonly baselineDigest: string
  readonly postRecoveryDigest: string
  readonly counts: {
    readonly revokedCredentials: number
    readonly leasedToPending: number
    readonly leasedToDeadLetter: number
    readonly generationIncrements: number
  }
  readonly assertions: QuarantineAssertions
}): string {
  return sha256(
    JSON.stringify({
      quarantinePolicyVersion: 1,
      sourceOverallDigest: input.sourceOverallDigest,
      schemaFingerprint: input.schemaFingerprint,
      baselineDigest: input.baselineDigest,
      postRecoveryDigest: input.postRecoveryDigest,
      counts: input.counts,
      assertions: input.assertions,
    }),
  )
}
