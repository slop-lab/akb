import type { Sql } from "postgres"
import { z } from "zod"
import {
  type ContentDocumentDiscoveryQuery,
  ContentDocumentDiscoveryResponseSchema,
  ContentDocumentSummarySchema,
  type ContextReadRequest,
} from "../contracts/content/workflow.ts"
import { EntityNotFoundError } from "../entities/errors.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import { AuthenticationRequiredError } from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { loadExplicitContext, type WorkflowReadContext } from "./context-loader.ts"

const SummaryRowSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  current_revision: z.coerce.number().int().positive(),
  lifecycle: z.literal("active"),
})

export class ContentWorkflowReadService {
  readonly #sql: Sql

  constructor(sql: Sql) {
    this.#sql = sql
  }

  templates(principal: AuthenticatedPrincipal, workspaceId: string): Promise<void> {
    return this.#sql.begin(async (transaction) => {
      const context = { transaction, principal, workspaceId }
      await lockWorkflowRead(context)
      const grants = await transaction`select 1 from membership_permissions
        where workspace_id=${workspaceId} and principal_id=${principal.principalId}
          and permission in ('content.read','content.manage') limit 1`
      if (grants.length !== 1) throw new EntityNotFoundError(workspaceId)
    })
  }

  discover(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    query: ContentDocumentDiscoveryQuery,
  ) {
    return this.#sql.begin(async (transaction) => {
      const context = { transaction, principal, workspaceId }
      await lockWorkflowRead(context)
      const rows = await discoverRows(context, query)
      const items = rows.slice(0, query.limit).map((row) =>
        ContentDocumentSummarySchema.parse({
          kind: query.kind,
          id: row.id,
          title: row.title,
          revision: row.current_revision,
          lifecycle: row.lifecycle,
        }),
      )
      return ContentDocumentDiscoveryResponseSchema.parse({
        items,
        nextAfterId: rows.length > query.limit ? (items.at(-1)?.id ?? null) : null,
        consistency: "live",
      })
    })
  }

  context(principal: AuthenticatedPrincipal, workspaceId: string, request: ContextReadRequest) {
    return this.#sql.begin(async (transaction) => {
      const context = { transaction, principal, workspaceId }
      await lockWorkflowRead(context)
      return loadExplicitContext(context, request)
    })
  }
}

async function lockWorkflowRead(context: WorkflowReadContext): Promise<void> {
  if (!(await lockAuthenticatedPrincipal(context.transaction, context.principal))) {
    throw new AuthenticationRequiredError()
  }
  if (context.workspaceId !== context.principal.workspaceId) {
    throw new EntityNotFoundError(context.workspaceId)
  }
  const authority = await context.transaction`select epoch from workspace_authority_epochs
    where workspace_id=${context.workspaceId} for share`
  if (authority.length !== 1) throw new EntityNotFoundError(context.workspaceId)
}

async function discoverRows(
  context: WorkflowReadContext,
  query: ContentDocumentDiscoveryQuery,
): Promise<readonly z.infer<typeof SummaryRowSchema>[]> {
  let values: readonly unknown[]
  switch (query.kind) {
    case "page":
      values =
        await context.transaction`select id,title,current_revision,lifecycle from content_documents
        where workspace_id=${context.workspaceId} and lifecycle='active' and id>${query.afterId}
          and (${query.query}='' or position(lower(${query.query}) in lower(title))>0)
          and entity_access_allowed(workspace_id,id,${context.principal.principalId},'content.read')
        order by id limit ${query.limit + 1}`
      break
    case "knowledge":
      values =
        await context.transaction`select id,title,current_revision,lifecycle from knowledge_objects
        where workspace_id=${context.workspaceId} and lifecycle='active' and id>${query.afterId}
          and (${query.query}='' or position(lower(${query.query}) in lower(title))>0)
          and entity_access_allowed(workspace_id,id,${context.principal.principalId},'knowledge.read')
        order by id limit ${query.limit + 1}`
      break
    default:
      return assertNever(query.kind)
  }
  return values.map((value) => SummaryRowSchema.parse(value))
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported document kind: ${String(value)}`)
}
