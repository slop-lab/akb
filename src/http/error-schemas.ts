import { z } from "zod"
import {
  IdempotencyKeySchema,
  RevisionSchema,
  WorkItemIdSchema,
} from "../work-items/identifiers.ts"

const ErrorMessageSchema = z.string().min(1)
const RetryableSchema = z.literal(false)

export const FieldErrorSchema = z.strictObject({
  field: z.string().min(1),
  message: ErrorMessageSchema,
})
export type FieldError = z.infer<typeof FieldErrorSchema>

export const InvalidArgumentErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("invalid_argument"),
    message: ErrorMessageSchema,
    retryable: RetryableSchema,
    fieldErrors: z.array(FieldErrorSchema),
  }),
})

export const WorkItemNotFoundErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("not_found"),
    message: ErrorMessageSchema,
    retryable: RetryableSchema,
    details: z.strictObject({ id: WorkItemIdSchema }),
  }),
})

export const RouteNotFoundErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("not_found"),
    message: ErrorMessageSchema,
    retryable: RetryableSchema,
    details: z.strictObject({ method: z.string().min(1), path: z.string().min(1) }),
  }),
})

export const IdempotencyConflictErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("idempotency_conflict"),
    message: ErrorMessageSchema,
    retryable: RetryableSchema,
    details: z.strictObject({ idempotencyKey: IdempotencyKeySchema }),
  }),
})

export const RevisionConflictErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("revision_conflict"),
    message: ErrorMessageSchema,
    retryable: RetryableSchema,
    details: z.strictObject({ expected: RevisionSchema, actual: RevisionSchema }),
  }),
})

export const BodyBudgetExceededErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("budget_exceeded"),
    message: ErrorMessageSchema,
    retryable: RetryableSchema,
    details: z.strictObject({ limit: z.number().int().positive() }),
  }),
})

export const CapacityExceededErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("budget_exceeded"),
    message: ErrorMessageSchema,
    retryable: RetryableSchema,
    details: z.strictObject({
      resource: z.enum(["items", "audit_records"]),
      capacity: z.number().int().nonnegative(),
    }),
  }),
})

export const InternalErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("internal"),
    message: ErrorMessageSchema,
    retryable: RetryableSchema,
    details: z.strictObject({}),
  }),
})
