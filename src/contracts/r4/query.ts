import { z } from "zod"

export const FILTER_FIELDS = [
  "spaceId",
  "projectId",
  "workflowStateId",
  "stateCategory",
  "priority",
  "accountableOwnerId",
  "type",
  "labelId",
  "startDate",
  "dueDate",
  "createdAt",
  "updatedAt",
  "archived",
] as const
export const SORT_FIELDS = [
  "createdAt",
  "updatedAt",
  "title",
  "priority",
  "dueDate",
  "workflowPosition",
] as const
const FilterFieldSchema = z.enum(FILTER_FIELDS)
const FilterScalarSchema = z.union([z.string(), z.number(), z.boolean()])
const REFERENCE_FILTER_FIELDS = ["spaceId", "projectId", "workflowStateId", "labelId"] as const

export type FilterNode =
  | { readonly op: "and" | "or"; readonly filters: readonly FilterNode[] }
  | { readonly op: "not"; readonly filter: FilterNode }
  | {
      readonly op: "eq"
      readonly field: (typeof FILTER_FIELDS)[number]
      readonly value: string | number | boolean
    }
  | {
      readonly op: "in"
      readonly field: (typeof FILTER_FIELDS)[number]
      readonly values: readonly (string | number | boolean)[]
    }
  | {
      readonly op: "range"
      readonly field: (typeof FILTER_FIELDS)[number]
      readonly from: string | number | null
      readonly to: string | number | null
    }
  | {
      readonly op: "is_null"
      readonly field: (typeof FILTER_FIELDS)[number]
      readonly value: boolean
    }
  | { readonly op: "relation"; readonly relationType: string; readonly entityId: string }

const RawFilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.strictObject({
      op: z.enum(["and", "or"]),
      filters: z.array(RawFilterNodeSchema).min(1).max(50).readonly(),
    }),
    z.strictObject({ op: z.literal("not"), filter: RawFilterNodeSchema }),
    z.strictObject({ op: z.literal("eq"), field: FilterFieldSchema, value: FilterScalarSchema }),
    z.strictObject({
      op: z.literal("in"),
      field: FilterFieldSchema,
      values: z.array(FilterScalarSchema).min(1).max(50).readonly(),
    }),
    z.strictObject({
      op: z.literal("range"),
      field: FilterFieldSchema,
      from: z.union([z.string(), z.number()]).nullable(),
      to: z.union([z.string(), z.number()]).nullable(),
    }),
    z.strictObject({ op: z.literal("is_null"), field: FilterFieldSchema, value: z.boolean() }),
    z.strictObject({
      op: z.literal("relation"),
      relationType: z.string().min(1).max(50),
      entityId: z.string().min(1).max(200),
    }),
  ]),
)

function filterSize(
  node: FilterNode,
  depth = 1,
): { readonly depth: number; readonly nodes: number } {
  if (node.op === "not") {
    const child = filterSize(node.filter, depth + 1)
    return { depth: child.depth, nodes: child.nodes + 1 }
  }
  if (node.op === "and" || node.op === "or") {
    return node.filters.reduce(
      (size, child) => {
        const childSize = filterSize(child, depth + 1)
        return { depth: Math.max(size.depth, childSize.depth), nodes: size.nodes + childSize.nodes }
      },
      { depth, nodes: 1 },
    )
  }
  return { depth, nodes: 1 }
}

export const FilterNodeSchema = RawFilterNodeSchema.superRefine((node, context) => {
  const size = filterSize(node)
  if (size.depth > 5) {
    context.addIssue({ code: "custom", message: "filter depth exceeds 5" })
  }
  if (size.nodes > 50) {
    context.addIssue({ code: "custom", message: "filter nodes exceed 50" })
  }
  validateFilterTypes(node, context)
})
export const SortSchema = z.strictObject({
  field: z.enum(SORT_FIELDS),
  direction: z.enum(["asc", "desc"]),
})
export const HumanWorkQuerySchema = z.strictObject({
  model: z.enum(["r4", "legacy"]),
  filter: FilterNodeSchema.nullable(),
  search: z.string().max(500).nullable(),
  sort: z.array(SortSchema).min(1).max(3).readonly(),
  includeArchived: z.boolean(),
  page: z.strictObject({ size: z.number().int().min(1).max(100), cursor: z.string().nullable() }),
})
export const QuerySnapshotSchema = z.strictObject({
  id: z.string().uuid(),
  expiresAt: z.iso.datetime(),
})
export type HumanWorkQuery = z.infer<typeof HumanWorkQuerySchema>
export type Sort = z.infer<typeof SortSchema>

function validateFilterTypes(node: FilterNode, context: z.RefinementCtx): void {
  switch (node.op) {
    case "and":
    case "or":
      for (const child of node.filters) validateFilterTypes(child, context)
      return
    case "not":
      validateFilterTypes(node.filter, context)
      return
    case "relation":
    case "is_null":
      return
    case "eq":
      validateValues(node.field, [node.value], context)
      return
    case "in":
      validateValues(node.field, node.values, context)
      return
    case "range":
      if (REFERENCE_FILTER_FIELDS.some((field) => field === node.field)) {
        context.addIssue({ code: "custom", message: `${node.field} does not support range` })
      }
      validateValues(node.field, [node.from, node.to], context)
      return
    default:
      assertNever(node)
  }
}

function validateValues(
  field: (typeof FILTER_FIELDS)[number],
  values: readonly (string | number | boolean | null)[],
  context: z.RefinementCtx,
): void {
  const expected = field === "archived" ? "boolean" : "string"
  if (values.some((value) => value !== null && typeof value !== expected)) {
    context.addIssue({ code: "custom", message: `${field} requires ${expected} values` })
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected filter variant: ${JSON.stringify(value)}`)
}
