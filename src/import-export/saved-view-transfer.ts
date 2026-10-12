import type { FilterNode, HumanWorkQuery, ImportRecord } from "../contracts/r4/index.ts"
import { type FILTER_FIELDS, HumanWorkQuerySchema } from "../contracts/r4/query.ts"

type GraphRecord = Exclude<ImportRecord, { readonly kind: "manifest" }>
type ReferenceKind = "space" | "project" | "workflow_state" | "label" | "work_item"
type TypedReference = { readonly kind: ReferenceKind; readonly id: string }

export type NormalizedSavedView =
  | {
      readonly kind: "normalized"
      readonly definition: HumanWorkQuery
      readonly references: readonly TypedReference[]
      readonly matchedRange: boolean
    }
  | { readonly kind: "unresolved_reference" }
  | { readonly kind: "budget_exceeded" }

export function normalizeSavedViewDefinition(
  definition: HumanWorkQuery,
  records: readonly ImportRecord[],
): NormalizedSavedView {
  const graph = referenceGraph(records)
  const references = new Map<string, TypedReference>()
  let unresolved = false
  let matchedRange = false
  let exceeded = false

  const visit = (node: FilterNode): FilterNode => {
    switch (node.op) {
      case "and":
      case "or":
        return { ...node, filters: node.filters.map(visit) }
      case "not":
        return { ...node, filter: visit(node.filter) }
      case "relation": {
        const reference =
          graph.get(referenceKey("project", node.entityId)) ??
          graph.get(referenceKey("work_item", node.entityId))
        if (reference === undefined) unresolved = true
        else references.set(referenceKey(reference.kind, reference.id), reference)
        return node
      }
      case "eq":
      case "in": {
        const kind = referenceKind(node.field)
        if (kind === undefined) return node
        const values = node.op === "eq" ? [node.value] : node.values
        for (const value of values) {
          if (typeof value !== "string") continue
          const reference = graph.get(referenceKey(kind, value))
          if (reference === undefined) unresolved = true
          else references.set(referenceKey(kind, value), reference)
        }
        return node
      }
      case "range": {
        const kind = referenceKind(node.field)
        if (kind === undefined) return node
        matchedRange = true
        if (node.from === null && node.to === null) {
          return kind === "label" ? { op: "is_null", field: "labelId", value: false } : node
        }
        const values = [...graph.values()]
          .filter(
            (reference) =>
              reference.kind === kind &&
              (node.from === null || reference.id >= node.from) &&
              (node.to === null || reference.id <= node.to),
          )
          .map((reference) => reference.id)
          .sort()
        if (values.length > 50) exceeded = true
        for (const value of values) {
          const reference = graph.get(referenceKey(kind, value))
          if (reference !== undefined) references.set(referenceKey(kind, value), reference)
        }
        if (values.length > 0) return { op: "in", field: node.field, values }
        if (kind !== "project") return falsePredicate(node.field)
        const reference = [...graph.values()].find((candidate) => candidate.kind === "project")
        if (reference === undefined) return node
        references.set(referenceKey(reference.kind, reference.id), reference)
        return nullableFalsePredicate(node.field, reference.id)
      }
      case "is_null":
        return node
      default:
        return assertNever(node)
    }
  }

  const filter = definition.filter === null ? null : visit(definition.filter)
  if (unresolved) return { kind: "unresolved_reference" }
  if (exceeded) return { kind: "budget_exceeded" }
  const parsed = HumanWorkQuerySchema.safeParse({ ...definition, filter })
  if (!parsed.success) return { kind: "budget_exceeded" }
  return {
    kind: "normalized",
    definition: parsed.data,
    references: [...references.values()],
    matchedRange,
  }
}

function referenceGraph(records: readonly ImportRecord[]): ReadonlyMap<string, TypedReference> {
  const references = new Map<string, TypedReference>()
  for (const record of records) {
    if (record.kind === "manifest") continue
    const kind = recordReferenceKind(record)
    if (kind !== undefined) {
      const reference = { kind, id: record.externalId }
      references.set(referenceKey(kind, record.externalId), reference)
    }
  }
  return references
}

function recordReferenceKind(record: GraphRecord): ReferenceKind | undefined {
  switch (record.kind) {
    case "space":
    case "project":
    case "workflow_state":
    case "label":
    case "work_item":
      return record.kind
    case "relation":
    case "comment":
    case "saved_view":
      return undefined
    default:
      return assertNever(record)
  }
}

function referenceKind(
  field: (typeof FILTER_FIELDS)[number],
): Exclude<ReferenceKind, "work_item"> | undefined {
  if (field === "spaceId") return "space"
  if (field === "projectId") return "project"
  if (field === "workflowStateId") return "workflow_state"
  if (field === "labelId") return "label"
  return undefined
}

function referenceKey(kind: ReferenceKind, id: string): string {
  return `${kind}:${id}`
}

function falsePredicate(field: (typeof FILTER_FIELDS)[number]): FilterNode {
  return {
    op: "and",
    filters: [
      { op: "is_null", field, value: true },
      { op: "is_null", field, value: false },
    ],
  }
}

function nullableFalsePredicate(
  field: (typeof FILTER_FIELDS)[number],
  referenceId: string,
): FilterNode {
  const equality = { op: "eq", field, value: referenceId } as const
  return { op: "and", filters: [equality, { op: "not", filter: equality }] }
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported transfer record: ${JSON.stringify(value)}`)
}
