import type { FilterNode, HumanWorkQuery, Sort } from "../../../../../src/contracts/r4/index.ts"

export type WorkView = "list" | "board"

export type WorkQueryDraft = {
  readonly source: HumanWorkQuery | null
  readonly spaceId: string
  readonly projectId: string
  readonly workflowStateId: string
  readonly stateCategory: string
  readonly accountableOwnerId: string
  readonly priority: string
  readonly type: string
  readonly labelId: string
  readonly startDateFrom: string
  readonly startDateTo: string
  readonly dueDateFrom: string
  readonly dueDateTo: string
  readonly search: string
  readonly includeArchived: boolean
  readonly sortField: Sort["field"]
  readonly sortDirection: Sort["direction"]
}

export function createWorkQueryDraft(spaceId: string, projectId = ""): WorkQueryDraft {
  return {
    source: null,
    spaceId,
    projectId,
    workflowStateId: "",
    stateCategory: "",
    accountableOwnerId: "",
    priority: "",
    type: "",
    labelId: "",
    startDateFrom: "",
    startDateTo: "",
    dueDateFrom: "",
    dueDateTo: "",
    search: "",
    includeArchived: false,
    sortField: "updatedAt",
    sortDirection: "desc",
  }
}

export function hydrateWorkQueryDraft(
  definition: HumanWorkQuery,
  fallbackSpaceId: string,
): WorkQueryDraft {
  const draft = createWorkQueryDraft(fallbackSpaceId)
  const direct = directFilters(definition.filter)
  return {
    ...draft,
    source: definition,
    spaceId: scalarValue(direct, "spaceId") ?? fallbackSpaceId,
    projectId: scalarValue(direct, "projectId") ?? "",
    workflowStateId: scalarValue(direct, "workflowStateId") ?? "",
    stateCategory: scalarValue(direct, "stateCategory") ?? "",
    accountableOwnerId: scalarValue(direct, "accountableOwnerId") ?? "",
    priority: scalarValue(direct, "priority") ?? "",
    type: scalarValue(direct, "type") ?? "",
    labelId: scalarValue(direct, "labelId") ?? "",
    startDateFrom: rangeValue(direct, "startDate", "from"),
    startDateTo: rangeValue(direct, "startDate", "to"),
    dueDateFrom: rangeValue(direct, "dueDate", "from"),
    dueDateTo: rangeValue(direct, "dueDate", "to"),
    search: definition.search ?? "",
    includeArchived: definition.includeArchived,
    sortField: definition.sort[0]?.field ?? "updatedAt",
    sortDirection: definition.sort[0]?.direction ?? "desc",
  }
}

export function changeWorkQueryDraft(
  draft: WorkQueryDraft,
  change: Partial<Omit<WorkQueryDraft, "source">>,
): WorkQueryDraft {
  return { ...draft, ...change, source: null }
}

export function applyWorkQueryDraft(draft: WorkQueryDraft, view: WorkView): HumanWorkQuery {
  if (draft.source !== null) return draft.source
  const filters: FilterNode[] = []
  addEqual(filters, "spaceId", draft.spaceId)
  addEqual(filters, "projectId", draft.projectId)
  addEqual(filters, "workflowStateId", draft.workflowStateId)
  addEqual(filters, "stateCategory", draft.stateCategory)
  addEqual(filters, "accountableOwnerId", draft.accountableOwnerId)
  addEqual(filters, "priority", draft.priority)
  addEqual(filters, "type", draft.type)
  addEqual(filters, "labelId", draft.labelId)
  addRange(filters, "startDate", draft.startDateFrom, draft.startDateTo)
  addRange(filters, "dueDate", draft.dueDateFrom, draft.dueDateTo)
  return {
    model: "r4",
    filter:
      filters.length === 0
        ? null
        : filters.length === 1
          ? (filters[0] ?? null)
          : { op: "and", filters },
    search: draft.search.trim() || null,
    sort: [{ field: draft.sortField, direction: draft.sortDirection }],
    includeArchived: draft.includeArchived,
    page: { size: view === "board" ? 25 : 50, cursor: null },
  }
}

function addEqual(
  filters: FilterNode[],
  field: Extract<FilterNode, { op: "eq" }>["field"],
  value: string,
): void {
  if (value.length > 0) filters.push({ op: "eq", field, value })
}

function addRange(
  filters: FilterNode[],
  field: "startDate" | "dueDate",
  from: string,
  to: string,
): void {
  if (from.length > 0 || to.length > 0)
    filters.push({ op: "range", field, from: from || null, to: to || null })
}

function directFilters(filter: FilterNode | null): readonly FilterNode[] {
  return filter?.op === "and" ? filter.filters : filter === null ? [] : [filter]
}

function scalarValue(filters: readonly FilterNode[], field: string): string | null {
  const node = filters.find((candidate) => candidate.op === "eq" && candidate.field === field)
  return node?.op === "eq" && typeof node.value === "string" ? node.value : null
}

function rangeValue(
  filters: readonly FilterNode[],
  field: "startDate" | "dueDate",
  side: "from" | "to",
): string {
  const node = filters.find((candidate) => candidate.op === "range" && candidate.field === field)
  if (node?.op !== "range") return ""
  const value = node[side]
  return typeof value === "string" ? value : ""
}
