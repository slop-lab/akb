import type { TransactionSql } from "postgres"
import { z } from "zod"
import { ContentDocumentSchema } from "../contracts/content/model.ts"
import {
  type ContentDocumentReference,
  type ContextReadItem,
  type ContextReadRequest,
  ContextReadResponseSchema,
  ContextSelectionDocumentError,
  parseContextSelectionDocument,
} from "../contracts/content/workflow.ts"
import { EntityNotFoundError } from "../entities/errors.ts"
import type { AuthenticatedPrincipal, WorkPermission } from "../identity/types.ts"
import { ContextBudgetExceededError, InvalidContextSelectionError } from "./workflow-errors.ts"

const RevisionRowSchema = z.strictObject({
  schema_version: z.string(),
  created_at: z.date(),
  canonical_snapshot: z.record(z.string(), z.json()),
})
const PageSnapshotSchema = z.object({ document: ContentDocumentSchema })

export type WorkflowReadContext = {
  readonly transaction: TransactionSql
  readonly principal: AuthenticatedPrincipal
  readonly workspaceId: string
}

export async function loadExplicitContext(
  context: WorkflowReadContext,
  request: ContextReadRequest,
) {
  const selectionPage = "selectionPage" in request ? request.selectionPage : null
  const references =
    "references" in request
      ? request.references
      : await readSelectionReferences(context, request.selectionPage)
  for (const reference of references) {
    await requireReference(context, reference)
  }
  const items: ContextReadItem[] = []
  let contentBytes = 0
  for (const reference of references) {
    const item = await readReferenceRevision(context, reference)
    const nextItems = [...items, item]
    contentBytes = Buffer.byteLength(JSON.stringify(nextItems), "utf8")
    if (contentBytes > request.maxBytes) {
      throw new ContextBudgetExceededError(contentBytes, request.maxBytes)
    }
    items.push(item)
  }
  return ContextReadResponseSchema.parse({
    scope: "explicit-selection",
    references,
    selectionPage,
    items,
    contentBytes,
    maxBytes: request.maxBytes,
  })
}

async function readSelectionReferences(
  context: WorkflowReadContext,
  selectionPage: { readonly id: string; readonly revision: number },
): Promise<readonly ContentDocumentReference[]> {
  const reference = {
    kind: "page",
    id: selectionPage.id,
    revision: selectionPage.revision,
  } as const
  await requireReference(context, reference)
  const revision = await readReferenceRevision(context, reference)
  try {
    const snapshot = PageSnapshotSchema.parse(revision.snapshot)
    const manifest = parseContextSelectionDocument(snapshot.document)
    if (manifest.workspaceId !== context.workspaceId) throw new InvalidContextSelectionError()
    return manifest.references
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      error instanceof ContextSelectionDocumentError
    ) {
      throw new InvalidContextSelectionError()
    }
    throw error
  }
}

async function requireReference(
  context: WorkflowReadContext,
  reference: ContentDocumentReference,
): Promise<void> {
  const expected = accessFor(reference)
  const rows = await context.transaction`select 1 from entities entity
    join entity_revisions revision on revision.entity_id=entity.id
      and revision.revision=${reference.revision}
    where entity.workspace_id=${context.workspaceId} and entity.id=${reference.id}
      and entity.kind=${expected.entityKind} and entity_access_allowed(${context.workspaceId},
        entity.id,${context.principal.principalId},${expected.permission})`
  if (rows.length !== 1) throw new EntityNotFoundError(reference.id)
}

async function readReferenceRevision(
  context: WorkflowReadContext,
  reference: ContentDocumentReference,
): Promise<ContextReadItem> {
  const expected = accessFor(reference)
  const rows = await context.transaction`select revision.schema_version,revision.created_at,
      revision.canonical_snapshot from entities entity join entity_revisions revision
      on revision.entity_id=entity.id where entity.workspace_id=${context.workspaceId}
      and entity.id=${reference.id} and entity.kind=${expected.entityKind}
      and revision.revision=${reference.revision}`
  const row = RevisionRowSchema.safeParse(rows[0])
  if (!row.success) throw new EntityNotFoundError(reference.id)
  return {
    kind: reference.kind,
    id: reference.id,
    revision: reference.revision,
    schemaVersion: row.data.schema_version,
    revisionCreatedAt: row.data.created_at.toISOString(),
    snapshot: row.data.canonical_snapshot,
  }
}

function accessFor(reference: ContentDocumentReference): {
  readonly entityKind: "page" | "knowledge_object"
  readonly permission: WorkPermission
} {
  switch (reference.kind) {
    case "page":
      return { entityKind: "page", permission: "content.read" }
    case "knowledge":
      return { entityKind: "knowledge_object", permission: "knowledge.read" }
    default:
      return assertNever(reference)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported context reference: ${JSON.stringify(value)}`)
}
