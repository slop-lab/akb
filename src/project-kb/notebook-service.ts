import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import { createPageRecord } from "../content/page-mutations.ts"
import { ContentReadService } from "../content/read-service.ts"
import type { Page } from "../contracts/content/model.ts"
import { type BatchMutationResult, CommandUnitOfWork } from "../entities/command-unit-of-work.ts"
import { CommandInvariantError, EntityNotFoundError } from "../entities/errors.ts"
import { linkEntityAccessDependency } from "../entities/registry.ts"
import type { FeatureCommandCall } from "../http/feature-command-router.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import {
  AuthenticationRequiredError,
  WorkspaceNotFoundError,
} from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import type { CreateProjectNotebook } from "./contracts.ts"

const MappingRowSchema = z.strictObject({ page_id: z.string() })

export type ProjectNotebook = {
  readonly projectId: string
  readonly notebook: Page | null
}

export class ProjectNotebookService {
  readonly #sql: Sql
  readonly #pages: ContentReadService

  constructor(sql: Sql) {
    this.#sql = sql
    this.#pages = new ContentReadService(sql)
  }

  async get(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectNotebook> {
    if (workspaceId !== principal.workspaceId) throw new EntityNotFoundError(workspaceId)
    const rows = await this.#sql`select notebook.page_id from projects project
      join membership_permissions content_grant
        on content_grant.workspace_id=project.workspace_id
        and content_grant.principal_id=${principal.principalId}
        and content_grant.permission='content.read'
      left join project_notebooks notebook
        on notebook.workspace_id=project.workspace_id and notebook.project_id=project.id
      where project.workspace_id=${workspaceId} and project.id=${projectId}
        and entity_access_allowed(project.workspace_id,project.id,
          ${principal.principalId},'project.read')`
    if (rows.length !== 1) throw new EntityNotFoundError(projectId)
    const row = z.object({ page_id: z.string().nullable() }).parse(rows[0])
    return {
      projectId,
      notebook: row.page_id === null ? null : await this.#pages.page(principal, row.page_id),
    }
  }

  create(
    call: FeatureCommandCall<"project-notebook.create">,
    projectId: string,
    input: CreateProjectNotebook,
  ): Promise<BatchMutationResult> {
    const pageId = `page:${call.commandId}`
    return this.#sql.begin(async (transaction) => {
      await requireProjectNotebookManagement(transaction, call, projectId)
      const mappings = await transaction`select page_id from project_notebooks
        where workspace_id=${call.workspaceId} and project_id=${projectId} for update`
      const mapping = mappings[0] === undefined ? undefined : MappingRowSchema.parse(mappings[0])
      if (mapping !== undefined && mapping.page_id !== pageId) {
        throw new CommandInvariantError("project_notebook_exists")
      }
      return new CommandUnitOfWork(transaction).execute(
        {
          workspaceId: call.workspaceId,
          principal: call.principal,
          commandId: call.commandId,
          idempotencyKey: call.idempotencyKey,
          action: call.action,
          route: call.route,
          payload: call.payload,
          primaryEntityId: pageId,
        },
        [{ entityId: pageId, expectedRevision: null, permission: "content.manage" }],
        async (commandTransaction, targets) => {
          const revision = targets.get(pageId)?.nextRevision
          if (revision === undefined)
            throw new CommandInvariantError("project_notebook_target_missing")
          const record = await createPageRecord(
            {
              transaction: commandTransaction,
              principal: call.principal,
              pageId,
              revision,
            },
            {
              spaceId: null,
              parentPageId: null,
              title: input.title,
              document: {
                version: 1,
                blocks: [
                  { id: "heading", type: "heading", level: 1, text: input.title, children: [] },
                  { id: "body", type: "paragraph", text: "", children: [] },
                ],
              },
            },
          )
          await commandTransaction`insert into project_notebooks
            (workspace_id,project_id,page_id) values (${call.workspaceId},${projectId},${pageId})`
          await linkEntityAccessDependency(commandTransaction, pageId, projectId)
          return { primaryEntityId: pageId, records: [record] }
        },
      )
    })
  }
}

async function requireProjectNotebookManagement(
  transaction: TransactionSql,
  call: FeatureCommandCall<"project-notebook.create">,
  projectId: string,
): Promise<void> {
  if (!(await lockAuthenticatedPrincipal(transaction, call.principal))) {
    throw new AuthenticationRequiredError()
  }
  if (call.workspaceId !== call.principal.workspaceId) throw new WorkspaceNotFoundError()
  await transaction`select pg_advisory_xact_lock(
    hashtextextended(${JSON.stringify([call.workspaceId, projectId, "project-notebook"])},0))`
  const rows = await transaction`select project.id from projects project
    join membership_permissions content_grant
      on content_grant.workspace_id=project.workspace_id
      and content_grant.principal_id=${call.principal.principalId}
      and content_grant.permission='content.manage'
    where project.workspace_id=${call.workspaceId} and project.id=${projectId}
      and entity_access_allowed(project.workspace_id,project.id,
        ${call.principal.principalId},'project.manage')
    for update of project for share of content_grant`
  if (rows.length !== 1) throw new EntityNotFoundError(projectId)
}
