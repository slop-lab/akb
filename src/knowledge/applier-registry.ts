import type { TransactionSql } from "postgres"
import type {
  KnowledgeCandidate,
  ProposalRelation,
  ProposalSource,
} from "../contracts/knowledge/index.ts"
import type { MutationRecord } from "../entities/mutation-types.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"

export type ProposalApplication = {
  readonly transaction: TransactionSql
  readonly principal: AuthenticatedPrincipal
  readonly action: string
  readonly targetId: string
  readonly revision: number
  readonly candidate: KnowledgeCandidate
  readonly proposalId: string
  readonly reviewId: string
  readonly reviewedAt: string
  readonly sources: readonly ProposalSource[]
  readonly relations: readonly ProposalRelation[]
}

export interface DomainProposalApplier {
  readonly actions: readonly string[]
  apply(input: ProposalApplication): Promise<MutationRecord>
}

export class ProposalApplierRegistry {
  readonly #appliers = new Map<string, DomainProposalApplier>()

  register(applier: DomainProposalApplier): void {
    for (const action of applier.actions) {
      if (this.#appliers.has(action))
        throw new TypeError(`proposal action already registered: ${action}`)
      this.#appliers.set(action, applier)
    }
  }

  require(action: string): DomainProposalApplier {
    const applier = this.#appliers.get(action)
    if (applier === undefined) throw new TypeError(`unsupported proposal action: ${action}`)
    return applier
  }
}
