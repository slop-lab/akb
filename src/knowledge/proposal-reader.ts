import type { Sql, TransactionSql } from "postgres"
import type {
  KnowledgeProposal,
  KnowledgeProposalStatus,
  KnowledgeProposalSummary,
} from "../contracts/knowledge/index.ts"
import { KnowledgeProposalSummarySchema } from "../contracts/knowledge/index.ts"
import { EntityNotFoundError } from "../entities/errors.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import {
  AuthenticationRequiredError,
  WorkspaceNotFoundError,
} from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"
import { loadProposal } from "./proposal-store.ts"

export class KnowledgeProposalReader {
  readonly #sql: Sql
  readonly #principal: AuthenticatedPrincipal

  constructor(sql: Sql, principal: AuthenticatedPrincipal) {
    this.#sql = sql
    this.#principal = principal
  }

  get(workspaceId: string, proposalId: string): Promise<KnowledgeProposal | undefined> {
    return this.#sql.begin(async (transaction) => {
      await authorizeWorkspace(transaction, this.#principal, workspaceId)
      const rows = await transaction`select 1 from knowledge_proposals proposal
        where proposal.workspace_id=${workspaceId} and proposal.id=${proposalId}
          and entity_access_allowed(proposal.workspace_id,proposal.id,
            ${this.#principal.principalId},'review.read')`
      if (rows.length !== 1) return undefined
      return loadProposal(transaction, workspaceId, proposalId)
    })
  }

  list(
    workspaceId: string,
    status: KnowledgeProposalStatus,
    limit: number,
  ): Promise<readonly KnowledgeProposalSummary[]> {
    return this.#sql.begin(async (transaction) => {
      await authorizeWorkspace(transaction, this.#principal, workspaceId)
      const rows = await transaction<{ readonly id: string }[]>`select proposal.id
        from knowledge_proposals proposal where proposal.workspace_id=${workspaceId}
          and proposal.status=${status}
          and entity_access_allowed(proposal.workspace_id,proposal.id,
            ${this.#principal.principalId},'review.read')
        order by proposal.created_at desc,proposal.id limit ${limit}`
      const proposals = await Promise.all(
        rows.map((row) => loadProposal(transaction, workspaceId, row.id)),
      )
      return proposals.map((proposal) =>
        KnowledgeProposalSummarySchema.parse({
          proposalId: proposal.proposalId,
          targetId: proposal.targetId,
          action: proposal.action,
          baseRevision: proposal.baseRevision,
          candidate: proposal.candidate,
          status: proposal.status,
          revision: proposal.revision,
          proposerId: proposal.proposerId,
          createdAt: proposal.createdAt,
        }),
      )
    })
  }
}

async function authorizeWorkspace(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  workspaceId: string,
): Promise<void> {
  if (!(await lockAuthenticatedPrincipal(transaction, principal))) {
    throw new AuthenticationRequiredError()
  }
  if (workspaceId !== principal.workspaceId) throw new WorkspaceNotFoundError()
  const grants = await transaction`select 1 from membership_permissions
    where workspace_id=${workspaceId} and principal_id=${principal.principalId}
      and permission='review.read'`
  if (grants.length !== 1) throw new EntityNotFoundError(workspaceId)
}
