import type {
  FilterNode,
  ImportRecord,
  ProjectCreatePayload,
  WorkItemCreatePayload,
} from "../contracts/r4/index.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import type { CommandCall } from "../pm/commands/types.ts"
import { ImportValidationError } from "./import-service.ts"
import { nextStatePosition } from "./workflow-state-position.ts"

export type ImportMappingContext = {
  readonly principal: AuthenticatedPrincipal
  readonly importId: string
  readonly entities: ReadonlyMap<string, string>
  readonly spaces: ReadonlyMap<string, string>
  readonly projectSlugs: ReadonlyMap<string, string>
  readonly records: readonly ImportRecord[]
}

export function toImportCommand(
  record: Exclude<ImportRecord, { readonly kind: "manifest" }>,
  context: ImportMappingContext,
): CommandCall {
  const common = {
    workspaceId: context.principal.workspaceId,
    principal: context.principal,
    commandId: `import:${context.importId}:${record.externalId}`,
    idempotencyKey: `import:${context.importId}:${record.externalId}`,
    baseRevision: null,
    route: `import:${record.kind}`,
    resourceId: null,
  }
  switch (record.kind) {
    case "space":
      return {
        ...common,
        action: "space.create",
        parentId: null,
        payload: {
          id: record.externalId,
          key: record.key,
          name: record.name,
          visibility: record.visibility ?? "private",
          description: record.description ?? "",
          icon: record.icon ?? null,
          leadId: record.leadId ?? null,
        },
      }
    case "workflow_state":
      return {
        ...common,
        action: "workflow-state.create",
        parentId: resolve(context.spaces, record.spaceId),
        payload: {
          id: record.externalId,
          name: record.name,
          category: record.category,
          color: record.color ?? "#64748B",
          position: record.position ?? nextStatePosition(record, context.records),
          isDefault: record.isDefault ?? false,
          active: record.active,
        },
      }
    case "project":
      return {
        ...common,
        ...(record.completedAt === undefined || record.completedAt === null
          ? {}
          : { restoredAt: record.completedAt }),
        action: "project.create",
        parentId: null,
        payload: projectPayload(record, context),
      }
    case "label":
      return {
        ...common,
        action: "label.create",
        parentId: resolve(context.spaces, record.spaceId),
        payload: { name: record.name, color: record.color },
      }
    case "work_item":
      return {
        ...common,
        ...(record.completedAt === undefined || record.completedAt === null
          ? {}
          : { restoredAt: record.completedAt }),
        action: "work-item.create",
        parentId: null,
        payload: workPayload(record, context),
      }
    case "relation":
      return {
        ...common,
        action: "relation.create",
        parentId: null,
        payload: {
          ...relationPayload(record, context.entities),
          archivedAt: record.archivedAt ?? null,
        },
      }
    case "comment":
      return {
        ...common,
        action: "comment.create",
        parentId: resolve(context.entities, record.subjectId),
        payload: { body: record.body },
      }
    case "saved_view":
      return {
        ...common,
        action: "saved-view.create",
        parentId: null,
        payload: {
          name: record.name,
          access: record.access ?? "private",
          scopeSpaceId:
            record.scopeSpaceId === null || record.scopeSpaceId === undefined
              ? null
              : resolve(context.spaces, record.scopeSpaceId),
          definition: remapDefinition(record.definition, context.entities, context.spaces),
        },
      }
  }
}

export function orderedImportRecords(records: readonly ImportRecord[]): readonly ImportRecord[] {
  const order = [
    "manifest",
    "space",
    "workflow_state",
    "project",
    "label",
    "work_item",
    "relation",
    "comment",
    "saved_view",
  ]
  return [...records].sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind))
}

function projectPayload(
  record: Extract<ImportRecord, { readonly kind: "project" }>,
  context: ImportMappingContext,
): ProjectCreatePayload {
  const participating =
    record.participatingSpaceIds ??
    context.records.flatMap((item) => ("spaceId" in item ? [item.spaceId] : []))
  return {
    name: record.name,
    slug: context.projectSlugs.get(record.externalId) ?? record.slug,
    summary: record.summary ?? "",
    ownerId: record.ownerId,
    leadIds: record.leadIds ?? [context.principal.principalId],
    participatingSpaceIds: [...new Set(participating.map((id) => resolve(context.spaces, id)))],
    state: record.state ?? "active",
    health: record.health ?? "on_track",
    priority: record.priority ?? "none",
    startDate: record.startDate ?? null,
    targetDate: record.targetDate ?? null,
  }
}

function workPayload(
  record: Extract<ImportRecord, { readonly kind: "work_item" }>,
  context: ImportMappingContext,
): WorkItemCreatePayload {
  return {
    spaceId: resolve(context.spaces, record.spaceId),
    title: record.title,
    accountableOwnerId: record.ownerId,
    description: record.description ?? "",
    type: record.type ?? "Task",
    workflowStateId: resolve(context.entities, record.stateId),
    projectId:
      record.projectId === null || record.projectId === undefined
        ? null
        : resolve(context.entities, record.projectId),
    priority: record.priority ?? "none",
    labelIds: (record.labelIds ?? []).map((id) => resolve(context.entities, id)),
    startDate: record.startDate ?? null,
    dueDate: record.dueDate ?? null,
  }
}

function relationPayload(
  record: Extract<ImportRecord, { readonly kind: "relation" }>,
  entities: ReadonlyMap<string, string>,
) {
  const fromEntityId = resolve(entities, record.fromId)
  const toEntityId = resolve(entities, record.toId)
  return record.relationType === "related_to" && fromEntityId > toEntityId
    ? { fromEntityId: toEntityId, relationType: record.relationType, toEntityId: fromEntityId }
    : { fromEntityId, relationType: record.relationType, toEntityId }
}

function remapDefinition(
  definition: Extract<ImportRecord, { readonly kind: "saved_view" }>["definition"],
  entities: ReadonlyMap<string, string>,
  spaces: ReadonlyMap<string, string>,
) {
  const remap = (node: FilterNode): FilterNode => {
    switch (node.op) {
      case "and":
      case "or":
        return { ...node, filters: node.filters.map(remap) }
      case "not":
        return { ...node, filter: remap(node.filter) }
      case "relation":
        return { ...node, entityId: resolve(entities, node.entityId) }
      case "eq":
        return { ...node, value: remapValue(node.field, node.value, entities, spaces) }
      case "in":
        return {
          ...node,
          values: node.values.map((value) => remapValue(node.field, value, entities, spaces)),
        }
      case "range":
      case "is_null":
        return node
    }
  }
  return { ...definition, filter: definition.filter === null ? null : remap(definition.filter) }
}

function remapValue(
  field: string,
  value: string | number | boolean,
  entities: ReadonlyMap<string, string>,
  spaces: ReadonlyMap<string, string>,
): string | number | boolean {
  if (typeof value !== "string") return value
  if (field === "spaceId") return resolve(spaces, value)
  if (["projectId", "workflowStateId", "labelId"].includes(field)) return resolve(entities, value)
  return value
}

function resolve(map: ReadonlyMap<string, string>, id: string): string {
  const value = map.get(id)
  if (value === undefined) throw new ImportValidationError("import reference has not been mapped")
  return value
}
