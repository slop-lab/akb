import type { TransactionSql } from "postgres"
import type { FilterNode, ImportRecord } from "../contracts/r4/index.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import type { ValidatedBatch } from "./import-service.ts"
import { ImportValidationError } from "./import-service.ts"

export type ImportPreparation = {
  readonly warnings: readonly string[]
  readonly projectSlugs: ReadonlyMap<string, string>
}

export async function prepareImport(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  batch: ValidatedBatch,
): Promise<ImportPreparation> {
  const records = batch.records.filter((record) => record.kind !== "manifest")
  const byId = new Map(records.map((record) => [record.externalId, record]))
  for (const record of records) validateRecord(record, byId, principal)
  validateParents(records)
  validateWorkflowStates(records)
  await requireHumans(transaction, principal, records)
  await requirePermissions(transaction, principal, records)
  await requireReusableSpaceAuthority(transaction, principal, records)
  return projectCollisionPlan(transaction, principal, batch.importId, records)
}

function validateRecord(
  record: Exclude<ImportRecord, { readonly kind: "manifest" }>,
  records: ReadonlyMap<string, Exclude<ImportRecord, { readonly kind: "manifest" }>>,
  principal: AuthenticatedPrincipal,
): void {
  const requireKind = (id: string, kinds: readonly string[]): void => {
    const target = records.get(id)
    if (target === undefined || !kinds.includes(target.kind))
      throw new ImportValidationError("import reference is unknown or has the wrong kind")
  }
  switch (record.kind) {
    case "space":
      return
    case "workflow_state":
      requireKind(record.spaceId, ["space"])
      return
    case "project":
      for (const id of record.participatingSpaceIds ?? []) requireKind(id, ["space"])
      requireDateOrder(record.startDate, record.targetDate)
      return
    case "label":
      requireKind(record.spaceId, ["space"])
      return
    case "work_item":
      requireKind(record.spaceId, ["space"])
      requireKind(record.stateId, ["workflow_state"])
      if (record.projectId !== null && record.projectId !== undefined)
        requireKind(record.projectId, ["project"])
      for (const id of record.labelIds ?? []) requireKind(id, ["label"])
      requireDateOrder(record.startDate, record.dueDate)
      return
    case "relation":
      requireKind(record.fromId, ["project", "work_item"])
      requireKind(record.toId, ["project", "work_item"])
      return
    case "comment":
      requireKind(record.subjectId, ["project", "work_item"])
      if (record.authorId !== principal.principalId)
        throw new ImportValidationError(
          "historical comment authors require an explicit supported owner map",
        )
      return
    case "saved_view":
      if (record.ownerId !== principal.principalId)
        throw new ImportValidationError("saved view owner must be the authenticated principal")
      if (
        (record.access === "space") !==
        (record.scopeSpaceId !== null && record.scopeSpaceId !== undefined)
      ) {
        throw new ImportValidationError("saved view scope is invalid")
      }
      if (record.scopeSpaceId !== null && record.scopeSpaceId !== undefined)
        requireKind(record.scopeSpaceId, ["space"])
      for (const reference of filterReferences(record.definition.filter))
        requireKind(reference.id, reference.kinds)
  }
}

function requireDateOrder(start: string | null | undefined, end: string | null | undefined): void {
  if (start !== null && start !== undefined && end !== null && end !== undefined && start > end) {
    throw new ImportValidationError("import date range is invalid")
  }
}

function validateParents(records: readonly ImportRecord[]): void {
  const parents = new Map<string, string>()
  for (const record of records) {
    if (
      record.kind !== "relation" ||
      record.relationType !== "parent_of" ||
      (record.archivedAt !== null && record.archivedAt !== undefined)
    )
      continue
    if (parents.has(record.toId)) throw new ImportValidationError("work item has multiple parents")
    parents.set(record.toId, record.fromId)
  }
  for (const start of parents.keys()) {
    const visited = new Set<string>()
    for (
      let current: string | undefined = start;
      current !== undefined;
      current = parents.get(current)
    ) {
      if (visited.has(current)) throw new ImportValidationError("parent relation cycle")
      visited.add(current)
    }
  }
}

function validateWorkflowStates(records: readonly ImportRecord[]): void {
  const spaces = records.filter((record) => record.kind === "space")
  for (const space of spaces) {
    const states = records
      .filter(isWorkflowState)
      .filter((record) => record.spaceId === space.externalId)
    if (states.length > 20) throw new ImportValidationError("workflow has at most 20 states")
    const positions = states.flatMap((state) =>
      state.position === undefined ? [] : [state.position],
    )
    if (new Set(positions).size !== positions.length)
      throw new ImportValidationError("workflow state positions must be unique")
    if (states.filter((state) => state.isDefault === true).length > 1)
      throw new ImportValidationError("workflow has one default state")
  }
}

async function requireHumans(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  records: readonly ImportRecord[],
): Promise<void> {
  const ids = new Set(
    records.flatMap((record) => {
      if (record.kind === "space")
        return record.leadId === null || record.leadId === undefined ? [] : [record.leadId]
      if (record.kind === "project") return [record.ownerId, ...(record.leadIds ?? [])]
      if (record.kind === "work_item") return [record.ownerId]
      if (record.kind === "comment") return [record.authorId]
      if (record.kind === "saved_view") return [record.ownerId]
      return []
    }),
  )
  for (const id of ids) {
    const rows = await transaction`select 1 from principals p join workspace_memberships m
      on m.workspace_id=p.workspace_id and m.principal_id=p.id where p.workspace_id=${principal.workspaceId}
        and p.id=${id} and p.kind='human' and p.status='active' and m.status='active'`
    if (rows.length !== 1)
      throw new ImportValidationError("import owner must be an active human member")
  }
}

async function requirePermissions(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  records: readonly ImportRecord[],
): Promise<void> {
  const required = new Set(["project.manage"])
  for (const record of records) {
    if (record.kind === "space" || record.kind === "workflow_state") required.add("space.manage")
    if (record.kind === "label" || record.kind === "project") required.add("project.manage")
    if (record.kind === "work_item") {
      required.add("work.create")
      required.add("work.assign")
    }
    if (record.kind === "relation") required.add("relation.manage")
    if (record.kind === "comment") required.add("comment.create")
    if (record.kind === "saved_view") required.add("view.manage")
  }
  const rows = await transaction<
    { readonly permission: string }[]
  >`select permission from membership_permissions
    where workspace_id=${principal.workspaceId} and principal_id=${principal.principalId}
      and permission=any(${transaction.array([...required])})`
  if (new Set(rows.map((row) => row.permission)).size !== required.size)
    throw new ImportValidationError("import authority denied")
}

async function requireReusableSpaceAuthority(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  records: readonly ImportRecord[],
): Promise<void> {
  for (const record of records) {
    if (record.kind !== "space") continue
    const rows = await transaction`select 1 from space_details d join entities e
      on e.workspace_id=d.workspace_id and e.scope_space_id=d.space_id and e.kind='space'
      where d.workspace_id=${principal.workspaceId} and d.space_key=${record.key}
        and entity_access_allowed(e.workspace_id,e.id,${principal.principalId},'space.manage')`
    const collision =
      await transaction`select 1 from space_details where workspace_id=${principal.workspaceId} and space_key=${record.key}`
    if (collision.length > 0 && rows.length !== 1)
      throw new ImportValidationError("space key is not reusable")
  }
}

async function projectCollisionPlan(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  importId: string,
  records: readonly ImportRecord[],
): Promise<ImportPreparation> {
  const projectSlugs = new Map<string, string>()
  const warnings: string[] = []
  for (const record of records) {
    if (record.kind !== "project") continue
    const rows =
      await transaction`select 1 from projects where workspace_id=${principal.workspaceId} and lower(slug)=lower(${record.slug})`
    if (rows.length === 0) continue
    const suffix = `-${importId.slice(0, 8)}`
    projectSlugs.set(record.externalId, `${record.slug.slice(0, 100 - suffix.length)}${suffix}`)
    warnings.push(`project ${record.externalId} slug renamed to avoid a collision`)
  }
  return { warnings, projectSlugs }
}

function filterReferences(
  node: FilterNode | null,
): readonly { readonly id: string; readonly kinds: readonly string[] }[] {
  if (node === null) return []
  switch (node.op) {
    case "and":
    case "or":
      return node.filters.flatMap(filterReferences)
    case "not":
      return filterReferences(node.filter)
    case "relation":
      return [{ id: node.entityId, kinds: ["project", "work_item"] }]
    case "eq":
    case "in": {
      const kinds =
        node.field === "spaceId"
          ? ["space"]
          : node.field === "projectId"
            ? ["project"]
            : node.field === "workflowStateId"
              ? ["workflow_state"]
              : node.field === "labelId"
                ? ["label"]
                : []
      const values = node.op === "eq" ? [node.value] : node.values
      return kinds.length === 0
        ? []
        : values.flatMap((value) => (typeof value === "string" ? [{ id: value, kinds }] : []))
    }
    case "range":
    case "is_null":
      return []
  }
}

function isWorkflowState(
  record: ImportRecord,
): record is Extract<ImportRecord, { readonly kind: "workflow_state" }> {
  return record.kind === "workflow_state"
}
