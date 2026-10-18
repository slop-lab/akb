import { z } from "zod"

const IdentifierSchema = z.string().trim().min(1).max(500)
const JsonObjectSchema = z.record(z.string(), z.unknown())

export const IntakeSourceSchema = z.enum(["human", "agent", "integration", "import"])
export const IntakeStateSchema = z.enum([
  "new",
  "clarifying",
  "accepted",
  "declined",
  "deferred",
  "duplicate",
])
export const IntakeCreateSchema = z.strictObject({
  source: IntakeSourceSchema,
  sourceRef: z.string().trim().max(2_000),
  targetSpaceId: IdentifierSchema,
  title: z.string().trim().min(1).max(500),
  body: z.string().max(100_000),
  suggestedDestination: z.string().trim().max(2_000).nullable().default(null),
})
export const IntakeAcceptSchema = z.strictObject({
  ownerId: IdentifierSchema,
  workflowStateId: IdentifierSchema,
  projectId: IdentifierSchema.nullable().default(null),
  itemType: z.string().trim().min(1).max(100).default("Task"),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).default("none"),
})
export const IntakeDispositionSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("clarifying"),
    question: z.string().trim().min(1).max(20_000),
  }),
  z.strictObject({ state: z.literal("declined"), reason: z.string().trim().min(1).max(20_000) }),
  z.strictObject({ state: z.literal("deferred"), snoozeUntil: z.iso.datetime() }),
  z.strictObject({ state: z.literal("duplicate"), duplicateOf: IdentifierSchema }),
])

export const RecurrenceScheduleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("daily"), interval: z.number().int().min(1).max(365) }),
  z.strictObject({
    kind: z.literal("weekly"),
    interval: z.number().int().min(1).max(52),
    weekday: z.number().int().min(0).max(6),
  }),
  z.strictObject({
    kind: z.literal("monthly"),
    interval: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(28),
  }),
  z.strictObject({
    kind: z.literal("cron"),
    expression: z
      .string()
      .regex(/^\d{1,2} \d{1,2} \* \* [0-6]$/)
      .refine((expression) => {
        const [minute, hour] = expression.split(" ").map(Number)
        return minute !== undefined && minute <= 59 && hour !== undefined && hour <= 23
      }),
  }),
])
export const RecurrenceCreateSchema = z.strictObject({
  templateId: IdentifierSchema,
  templateRevision: z.number().int().positive(),
  targetSpaceId: IdentifierSchema,
  schedule: RecurrenceScheduleSchema,
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((timezone) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format()
        return true
      } catch (error) {
        if (error instanceof RangeError) return false
        throw error
      }
    }),
  incompletePolicy: z.enum(["skip", "create", "merge"]),
  nextRunAt: z.iso.datetime(),
  title: z.string().trim().min(1).max(500),
})

export const AutomationTriggerSchema = z.strictObject({
  eventType: z.string().trim().min(1).max(200),
})
export const AutomationConditionSchema = z.strictObject({
  field: z.string().trim().min(1).max(200),
  equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
})
export const AutomationActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("create_intake"),
    title: z.string().trim().min(1).max(500),
    body: z.string().max(100_000),
    targetSpaceId: IdentifierSchema,
  }),
  z.strictObject({
    kind: z.literal("webhook"),
    endpointId: IdentifierSchema,
    body: JsonObjectSchema,
  }),
  z.strictObject({ kind: z.literal("archive"), entityId: IdentifierSchema }),
])
export const AutomationCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  trigger: AutomationTriggerSchema,
  conditions: z.array(AutomationConditionSchema).max(20),
  actions: z.array(AutomationActionSchema).min(1).max(20),
  maxRunsPerMinute: z.number().int().min(1).max(1_000).default(60),
})

export const GitHubInstallationSchema = z.strictObject({
  externalInstallationId: IdentifierSchema,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  webhookSecret: z.string().min(32).max(1_000),
  apiBaseUrl: z.url().refine((value) => new URL(value).protocol === "https:"),
  allowedHosts: z
    .array(
      z
        .string()
        .regex(
          /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
        ),
    )
    .min(1)
    .max(20),
})
export const GitHubMappingSchema = z.strictObject({
  installationId: IdentifierSchema,
  githubNumber: z.number().int().positive(),
  entityId: IdentifierSchema,
})
export const GitHubMappingResponseSchema = z.strictObject({ mapped: z.literal(true) })

export const ExtensionManifestSchema = z.strictObject({
  id: IdentifierSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  protocolVersion: z.literal("1"),
  permissions: z
    .array(z.enum(["automation.read", "automation.manage", "content.read", "knowledge.read"]))
    .max(20),
  endpointUrl: z.url().refine((value) => new URL(value).protocol === "https:"),
  eventSubscriptions: z.array(z.string().trim().min(1).max(200)).max(100),
  commands: z.array(z.string().trim().min(1).max(200)).max(100),
})
export const ExtensionApprovalSchema = z.strictObject({
  manifestId: IdentifierSchema,
  manifestVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  approvedPermissions: z.array(z.string()).max(20),
})
export const ExtensionManifestResponseSchema = z.strictObject({
  id: IdentifierSchema,
  version: ExtensionManifestSchema.shape.version,
})

export const AnalyticsQuerySchema = z.strictObject({
  metric: z.enum(["throughput", "overdue", "blocked", "run_outcomes", "proposal_acceptance"]),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
})
export const AnalyticsResponseSchema = z.strictObject({
  metric: AnalyticsQuerySchema.shape.metric,
  value: z.number().int().nonnegative(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
})

export type RecurrenceSchedule = z.infer<typeof RecurrenceScheduleSchema>
export type AutomationAction = z.infer<typeof AutomationActionSchema>
export type AnalyticsResponse = z.infer<typeof AnalyticsResponseSchema>
