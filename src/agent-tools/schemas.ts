import { isJson, isJsonObject } from "@slop-lab/part/contracts/index.js"
import type { Contracts } from "@slop-lab/part/reference/index.js"
import { type ZodType, z } from "zod"

export type ToolObject = Readonly<Record<string, Contracts.Json>>

export function partSchema<T>(id: string, source: ZodType<T>): Contracts.Schema<T> {
  return {
    ref: { id, version: 1 },
    validate(input) {
      const parsed = source.safeParse(input)
      if (parsed.success) return { ok: true, value: parsed.data }
      return {
        ok: false,
        error: parsed.error.issues.map((issue) => ({
          path: issue.path.map((part) =>
            typeof part === "symbol" ? (part.description ?? "symbol") : part,
          ),
          code: issue.code,
          message: issue.message,
        })),
      }
    },
  }
}

export function partObjectSchema(id: string, source: ZodType): Contracts.Schema<ToolObject> {
  return {
    ref: { id, version: 1 },
    validate(input) {
      const parsed = source.safeParse(input)
      if (parsed.success && isJsonObject(parsed.data)) return { ok: true, value: parsed.data }
      return {
        ok: false,
        error: parsed.success
          ? [{ path: [], code: "invalid_type", message: "Expected a JSON object" }]
          : parsed.error.issues.map((issue) => ({
              path: issue.path.map((part) =>
                typeof part === "symbol" ? (part.description ?? "symbol") : part,
              ),
              code: issue.code,
              message: issue.message,
            })),
      }
    },
  }
}

export function modelSchema(source: ZodType): Contracts.Json {
  const exported: unknown = z.toJSONSchema(source, { io: "input" })
  const normalized: unknown = JSON.parse(JSON.stringify(exported))
  if (!isJson(normalized)) throw new TypeError("Zod generated a non-JSON schema")
  return normalized
}

export const EmptyInputSchema = z.strictObject({})
export const EntityInputSchema = z.strictObject({ id: z.string().trim().min(1).max(200) })
export const SnapshotInputSchema = z.strictObject({ snapshotId: z.string().uuid() })

export function commandInputSchema(options: {
  readonly payload: ZodType
  readonly parent: boolean
  readonly resource: boolean
}): ZodType {
  return z.strictObject({
    baseRevision: z.number().int().positive().nullable(),
    payload: options.payload,
    ...(options.parent ? { parentId: z.string().trim().min(1).max(200) } : {}),
    ...(options.resource ? { resourceId: z.string().trim().min(1).max(200) } : {}),
  })
}
