import type { TransactionSql } from "postgres"
import type { FILTER_FIELDS, FilterNode } from "../contracts/r4/query.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { canReadEntity } from "./read-authorization.ts"

type ReferenceField = "spaceId" | "projectId" | "workflowStateId" | "labelId"

export async function canReadFilterReferences(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  node: FilterNode | null,
): Promise<boolean> {
  if (node === null) return true
  switch (node.op) {
    case "and":
    case "or": {
      const results = await Promise.all(
        node.filters.map((child) => canReadFilterReferences(transaction, principal, child)),
      )
      return results.every(Boolean)
    }
    case "not":
      return canReadFilterReferences(transaction, principal, node.filter)
    case "relation":
      return canReadEntity(transaction, principal, node.entityId)
    case "eq":
    case "in": {
      const field = referenceField(node.field)
      if (field === undefined) return true
      const values = (node.op === "eq" ? [node.value] : node.values).filter(
        (value): value is string => typeof value === "string",
      )
      const results = await Promise.all(
        values.map((value) => canReadExplicitReference(transaction, principal, field, value)),
      )
      return results.every(Boolean)
    }
    case "range": {
      const field = referenceField(node.field)
      if (field === undefined) return true
      const bounds = [node.from, node.to].filter(
        (value): value is string => typeof value === "string",
      )
      const results = await Promise.all(
        bounds.map((value) => canReadRangeBound(transaction, principal, field, value)),
      )
      return results.every(Boolean)
    }
    case "is_null":
      return true
    default:
      return assertNever(node)
  }
}

async function canReadExplicitReference(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  field: ReferenceField,
  value: string,
): Promise<boolean> {
  const entityId = await resolveTypedEntityId(transaction, principal.workspaceId, field, value)
  return entityId !== undefined && canReadEntity(transaction, principal, entityId)
}

async function canReadRangeBound(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  field: ReferenceField,
  value: string,
): Promise<boolean> {
  const entityId = await resolveTypedEntityId(transaction, principal.workspaceId, field, value)
  return entityId === undefined || canReadEntity(transaction, principal, entityId)
}

async function resolveTypedEntityId(
  transaction: TransactionSql,
  workspaceId: string,
  field: ReferenceField,
  value: string,
): Promise<string | undefined> {
  if (field === "spaceId") {
    const [row] = await transaction<{ readonly id: string }[]>`select stable_space_entity_id(
      s.workspace_id,s.id) id from spaces s where s.workspace_id=${workspaceId} and s.id=${value}`
    return row?.id
  }
  const kind =
    field === "projectId" ? "project" : field === "workflowStateId" ? "workflow_state" : "label"
  const [row] = await transaction<{ readonly id: string }[]>`select e.id from entities e
    where e.workspace_id=${workspaceId} and e.id=${value} and e.kind=${kind}`
  return row?.id
}

function referenceField(field: (typeof FILTER_FIELDS)[number]): ReferenceField | undefined {
  return field === "spaceId" ||
    field === "projectId" ||
    field === "workflowStateId" ||
    field === "labelId"
    ? field
    : undefined
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported filter reference variant: ${JSON.stringify(value)}`)
}
