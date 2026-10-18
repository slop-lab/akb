import { randomUUID } from "node:crypto"
import type { Sql } from "postgres"
import {
  CreateKnowledgeProposalSchema,
  DecideKnowledgeProposalSchema,
} from "../contracts/knowledge/index.ts"
import {
  type BatchMutationResult,
  type CommandTarget,
  CommandUnitOfWork,
} from "../entities/command-unit-of-work.ts"
import { CommandInvariantError } from "../entities/errors.ts"
import type { MutationRecord } from "../entities/mutation-types.ts"
import { insertEntity, linkEntityAccessDependency } from "../entities/registry.ts"
import type { FeatureCommandCall, FeatureCommandExecutor } from "../http/feature-command-router.ts"
import { ProposalApplierRegistry } from "./applier-registry.ts"
import { KnowledgeObjectApplier } from "./canonical-applier.ts"
import {
  insertReview,
  proposalCreatedRecord,
  proposalDecisionRecord,
  requiredTarget,
  reviewRecord,
  validateProposalTarget,
} from "./command-support.ts"
import { insertProposal, loadProposal } from "./proposal-store.ts"
import { requireAuthorizedProvenance } from "./provenance.ts"
import { resolveKnowledgeReviewPolicy } from "./review-policy.ts"

export const KNOWLEDGE_ACTIONS = ["knowledge.proposal.create", "knowledge.review.decide"] as const
export type KnowledgeAction = (typeof KNOWLEDGE_ACTIONS)[number]
export type KnowledgeCommandDependencies = {
  readonly newProposalId?: () => string
  readonly newReviewId?: () => string
  readonly now?: () => string
  readonly appliers?: ProposalApplierRegistry
}

export class KnowledgeCommandService implements FeatureCommandExecutor<KnowledgeAction> {
  readonly #sql: Sql
  readonly #unit: CommandUnitOfWork
  readonly #newProposalId: () => string
  readonly #newReviewId: () => string
  readonly #now: () => string
  readonly #appliers: ProposalApplierRegistry

  constructor(sql: Sql, dependencies: KnowledgeCommandDependencies = {}) {
    this.#sql = sql
    this.#newProposalId = dependencies.newProposalId ?? (() => `knowledge-proposal:${randomUUID()}`)
    this.#newReviewId = dependencies.newReviewId ?? (() => `knowledge-review:${randomUUID()}`)
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#unit = new CommandUnitOfWork(sql)
    this.#appliers = dependencies.appliers ?? new ProposalApplierRegistry()
    if (dependencies.appliers === undefined) this.#appliers.register(new KnowledgeObjectApplier())
  }

  execute(call: FeatureCommandCall<KnowledgeAction>): Promise<BatchMutationResult> {
    switch (call.action) {
      case "knowledge.proposal.create":
        return this.#propose(call)
      case "knowledge.review.decide":
        return this.#decide(call)
      default:
        return assertNever(call.action)
    }
  }

  #propose(call: FeatureCommandCall<KnowledgeAction>): Promise<BatchMutationResult> {
    const value = CreateKnowledgeProposalSchema.parse(call.payload)
    const proposalId = this.#newProposalId()
    return this.#unit.execute(
      batchInput(call, proposalId),
      [{ entityId: proposalId, expectedRevision: null, permission: "knowledge.propose" }],
      async (transaction, locked) => {
        await validateProposalTarget(transaction, call, value)
        await requireAuthorizedProvenance(transaction, call.principal, value)
        await insertEntity(transaction, {
          id: proposalId,
          workspaceId: call.workspaceId,
          kind: "knowledge_proposal",
          scopeSpaceId: null,
          actorId: call.principal.principalId,
        })
        await insertProposal(
          transaction,
          proposalId,
          call.workspaceId,
          call.principal.principalId,
          value,
        )
        if (value.action === "knowledge.revise") {
          await linkEntityAccessDependency(transaction, proposalId, value.targetId)
        }
        for (const source of value.sources) {
          if (source.kind === "entity")
            await linkEntityAccessDependency(transaction, proposalId, source.entityId)
        }
        for (const relation of value.relations) {
          await linkEntityAccessDependency(transaction, proposalId, relation.entityId)
        }
        return {
          primaryEntityId: proposalId,
          records: [proposalCreatedRecord(proposalId, value, locked)],
        }
      },
    )
  }

  async #decide(call: FeatureCommandCall<KnowledgeAction>): Promise<BatchMutationResult> {
    const proposalId = required(call.resourceId)
    const decision = DecideKnowledgeProposalSchema.parse(call.payload)
    const proposal = await this.#sql.begin((transaction) =>
      loadProposal(transaction, call.workspaceId, proposalId),
    )
    if (proposal.status !== "pending") throw new CommandInvariantError("proposal_already_decided")
    const reviewId = this.#newReviewId()
    const canonicalTargets: readonly CommandTarget[] =
      decision.decision === "accepted"
        ? [
            {
              entityId: proposal.targetId,
              expectedRevision: proposal.baseRevision,
              permission: "knowledge.accept",
            },
          ]
        : []
    const targets: readonly CommandTarget[] = [
      {
        entityId: proposalId,
        expectedRevision: requiredRevision(call.baseRevision),
        permission: "review.decide",
      },
      { entityId: reviewId, expectedRevision: null, permission: "review.decide" },
      ...canonicalTargets,
    ]
    return this.#unit.execute(
      batchInput(call, proposalId),
      targets,
      async (transaction, locked) => {
        const current = await loadProposal(transaction, call.workspaceId, proposalId)
        if (current.status !== "pending")
          throw new CommandInvariantError("proposal_already_decided")
        if (current.revision !== call.baseRevision)
          throw new CommandInvariantError("proposal_revision_changed")
        if (decision.decision === "accepted") {
          await requireAuthorizedProvenance(transaction, call.principal, current)
        }
        const policy = await resolveKnowledgeReviewPolicy(transaction, decision)
        const reviewedAt = this.#now()
        await insertReview(transaction, {
          call,
          proposal: current,
          decision,
          policy,
          reviewId,
          reviewedAt,
        })
        await transaction`update knowledge_proposals set status=${decision.decision},revision=2,
        decided_at=${reviewedAt} where id=${proposalId}`
        const records: MutationRecord[] = [
          proposalDecisionRecord(current, decision, reviewId, locked),
          reviewRecord(current, decision, policy, reviewId, reviewedAt),
        ]
        if (decision.decision === "accepted") {
          const target = requiredTarget(locked, current.targetId)
          const applier = this.#appliers.require(current.action)
          records.push(
            await applier.apply({
              transaction,
              principal: call.principal,
              action: current.action,
              targetId: current.targetId,
              revision: target.nextRevision,
              candidate: current.candidate,
              proposalId,
              reviewId,
              reviewedAt,
              sources: current.sources,
              relations: current.relations,
            }),
          )
        }
        return { primaryEntityId: proposalId, records }
      },
    )
  }
}

function batchInput(call: FeatureCommandCall<KnowledgeAction>, primaryEntityId: string) {
  return { ...call, primaryEntityId }
}
function required(value: string | null): string {
  if (value === null) throw new CommandInvariantError("resource_id_required")
  return value
}
function requiredRevision(value: number | null): number {
  if (value === null) throw new CommandInvariantError("base_revision_required")
  return value
}
function assertNever(value: never): never {
  throw new CommandInvariantError(`unsupported_knowledge_command:${String(value)}`)
}
