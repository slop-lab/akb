import { z } from "zod"
import { ArtifactIdSchema, InstallationIdSchema, RunIdSchema } from "./identifiers.ts"
import { RUNTIME_PROTOCOL_VERSION, RuntimeCapabilitySchema } from "./registry.ts"

export const RUN_STATES = [
  "queued",
  "preparing",
  "running",
  "awaiting_input",
  "verifying",
  "review_required",
  "completed",
  "failed",
  "cancel_requested",
  "canceled",
  "stale",
] as const

export const RunStateSchema = z.enum(RUN_STATES)
export const StartRunInputSchema = z.strictObject({
  installationId: InstallationIdSchema,
  subjectRef: z.string().trim().min(1).max(500),
  directiveRef: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(200),
  parentRunId: RunIdSchema.nullable().default(null),
  requestedCapabilities: z.array(RuntimeCapabilitySchema).max(16).default([]),
})
export const RunStartResponseSchema = z.strictObject({
  runId: RunIdSchema,
  installationId: InstallationIdSchema,
  subjectRef: z.string(),
  directiveRef: z.string(),
  bootstrapHandle: z.string(),
  callbackBaseUrl: z.string(),
  runToken: z.string().regex(/^afwr_[A-Za-z0-9_-]{43}$/),
  leaseExpiresAt: z.iso.datetime(),
  protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
  generation: z.number().int().positive(),
})
export const GenerationInputSchema = z.strictObject({ generation: z.number().int().positive() })
export const ResumeRunInputSchema = z.strictObject({
  idempotencyKey: z.string().trim().min(1).max(200),
  input: z.record(z.string(), z.unknown()).optional(),
})
export const DelegateRunInputSchema = StartRunInputSchema.omit({ installationId: true }).extend({
  installationId: InstallationIdSchema,
  generation: z.number().int().positive(),
})
export const ActivityInputSchema = z.strictObject({
  generation: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
  kind: z.enum([
    "progress",
    "observation",
    "action.started",
    "action.completed",
    "question",
    "input.received",
    "plan.changed",
    "artifact.produced",
    "verification",
    "proposal.created",
    "handoff",
    "warning",
    "response",
    "error",
  ]),
  durable: z.boolean(),
  body: z.record(z.string(), z.unknown()),
  references: z.array(z.string().max(500)).max(128),
  rawTraceRefs: z.array(z.string().max(500)).max(128),
})
export const PlanStepInputSchema = z.strictObject({
  generation: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
  stepId: z.string().trim().min(1).max(200),
  parentStepId: z.string().trim().min(1).max(200).nullable(),
  title: z.string().trim().min(1).max(500),
  status: z.enum(["proposed", "ready", "running", "blocked", "completed", "failed", "canceled"]),
  dependsOn: z.array(z.string().trim().min(1).max(200)).max(128),
  resultRefs: z.array(z.string().trim().min(1).max(500)).max(128),
  baseRevision: z.number().int().nonnegative(),
})
export const ArtifactChunkInputSchema = z.strictObject({
  generation: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
  artifactId: ArtifactIdSchema,
  kind: z.enum(["file", "diff", "report", "log", "test_result", "screenshot", "dataset"]),
  mediaType: z.string().trim().min(1).max(200),
  retentionClass: z.enum(["durable", "run_trace", "temporary"]),
  chunkIndex: z.number().int().min(0).max(9999),
  final: z.boolean(),
  bytes: z.string().max(350_000),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
})

export type StartRunInput = z.infer<typeof StartRunInputSchema>
export type RunStartResponse = z.infer<typeof RunStartResponseSchema>
