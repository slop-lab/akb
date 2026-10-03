import { z, type output, type ZodType } from "zod"
import type { FieldError } from "./error-schemas.ts"

export const RawPathSegmentSchema = z
  .string()
  .regex(/^[^/\\]*$/, "path segment contains a separator")

export type PathSegmentResult<T> =
  | { readonly kind: "valid"; readonly value: T }
  | { readonly kind: "invalid"; readonly fieldErrors: readonly FieldError[] }

export function parsePathSegment<Schema extends ZodType>(
  raw: string | undefined,
  field: string,
  schema: Schema,
): PathSegmentResult<output<Schema>> {
  if (raw === undefined) {
    return { kind: "invalid", fieldErrors: [{ field, message: "path segment is required" }] }
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch (error) {
    if (error instanceof URIError) {
      return {
        kind: "invalid",
        fieldErrors: [{ field, message: "path segment encoding is invalid" }],
      }
    }
    throw error
  }
  const parsed = schema.safeParse(decoded)
  if (!parsed.success) {
    return {
      kind: "invalid",
      fieldErrors: parsed.error.issues.map((issue) => ({
        field: [field, ...issue.path.map(String)].join("."),
        message: issue.message,
      })),
    }
  }
  return { kind: "valid", value: parsed.data }
}
