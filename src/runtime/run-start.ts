import { createHash } from "node:crypto"
import type { RunStartResponse } from "../contracts/runtime/index.ts"
import { RUNTIME_PROTOCOL_VERSION, RunStartResponseSchema } from "../contracts/runtime/index.ts"

export function runStartResponse(
  run: {
    readonly id: string
    readonly installationId: string
    readonly subjectRef: string
    readonly directiveRef: string
  },
  token: string,
  generation: number,
  leaseExpiresAt: string,
): RunStartResponse {
  return RunStartResponseSchema.parse({
    runId: run.id,
    installationId: run.installationId,
    subjectRef: run.subjectRef,
    directiveRef: run.directiveRef,
    bootstrapHandle: `bootstrap:${run.id}`,
    callbackBaseUrl: `/api/runtime/v1/runs/${encodeURIComponent(run.id)}`,
    runToken: token,
    leaseExpiresAt,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    generation,
  })
}

export function runtimeFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
