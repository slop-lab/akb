import type { TransactionSql } from "postgres"
import type {
  CreateKnowledgeProposalSchema,
  DecideKnowledgeProposal,
} from "../contracts/knowledge/index.ts"
import type { LockedCommandTarget } from "../entities/command-unit-of-work.ts"
import { CommandInvariantError, EntityNotFoundError } from "../entities/errors.ts"
import type { MutationRecord } from "../entities/mutation-types.ts"
import { insertEntity, linkEntityAccessDependency } from "../entities/registry.ts"
import type { FeatureCommandCall } from "../http/feature-command-router.ts"
import type { KnowledgeAction } from "./command-service.ts"
import type { StoredProposal } from "./proposal-store.ts"
import type { KnowledgeReviewPolicy } from "./review-policy.ts"

export async function validateProposalTarget(
  transaction: TransactionSql,
  call: FeatureCommandCall<KnowledgeAction>,
  value: ReturnType<typeof CreateKnowledgeProposalSchema.parse>,
): Promise<void> {
  const rows = await transaction`select current_revision from entities
    where workspace_id=${call.workspaceId} and id=${value.targetId}`
  if (value.action === "knowledge.create") {
    if (rows.length > 0) throw new CommandInvariantError("knowledge_target_exists")
    return
  }
  const visible = await transaction`select 1 from entities where workspace_id=${call.workspaceId}
    and id=${value.targetId} and kind='knowledge_object'
    and current_revision=${value.baseRevision}
    and entity_access_allowed(${call.workspaceId},id,${call.principal.principalId},'knowledge.read')`
  if (visible.length !== 1) throw new EntityNotFoundError(value.targetId)
}

type ReviewInsert = {
  readonly call: FeatureCommandCall<KnowledgeAction>
  readonly proposal: StoredProposal
  readonly decision: DecideKnowledgeProposal
  readonly policy: KnowledgeReviewPolicy
  readonly reviewId: string
  readonly reviewedAt: string
}

export async function insertReview(
  transaction: TransactionSql,
  input: ReviewInsert,
): Promise<void> {
  await insertEntity(transaction, {
    id: input.reviewId,
    workspaceId: input.call.workspaceId,
    kind: "knowledge_review",
    scopeSpaceId: null,
    actorId: input.call.principal.principalId,
  })
  await linkEntityAccessDependency(transaction, input.reviewId, input.proposal.proposalId)
  await transaction`insert into knowledge_reviews
    (id,workspace_id,proposal_id,proposal_revision,subject_id,subject_revision,decision,
      reviewer_id,policy_id,policy_revision,profile_id,profile_revision,input_revision,rationale,created_at)
    values (${input.reviewId},${input.call.workspaceId},${input.proposal.proposalId},
      ${input.proposal.revision},${input.proposal.targetId},${input.proposal.baseRevision},
      ${input.decision.decision},${input.call.principal.principalId},${input.policy.id},
      ${input.policy.revision},${input.proposal.profileId},${input.proposal.profileRevision},
      ${input.proposal.inputRevision},${input.decision.rationale},${input.reviewedAt})`
  for (const [ordinal, source] of input.proposal.sources.entries()) {
    const sourceRef = source.kind === "entity" ? source.entityId : source.artifactId
    const revision = source.kind === "entity" ? source.revision : null
    await transaction`insert into knowledge_review_evidence
      (review_id,ordinal,source_kind,source_ref,source_revision,evidence_role)
      values (${input.reviewId},${ordinal},${source.kind},${sourceRef},${revision},${source.role})`
  }
}

export function proposalCreatedRecord(
  proposalId: string,
  value: ReturnType<typeof CreateKnowledgeProposalSchema.parse>,
  locked: ReadonlyMap<string, LockedCommandTarget>,
): MutationRecord {
  return {
    entityId: proposalId,
    kind: "knowledge_proposal",
    revision: requiredTarget(locked, proposalId).nextRevision,
    schemaVersion: "knowledge-proposal.r7.v1",
    eventType: "entity.created",
    snapshot: { ...value, status: "pending" },
    eventData: { action: value.action, targetId: value.targetId },
    result: { proposalId, targetId: value.targetId },
  }
}

export function proposalDecisionRecord(
  proposal: StoredProposal,
  decision: DecideKnowledgeProposal,
  reviewId: string,
  locked: ReadonlyMap<string, LockedCommandTarget>,
): MutationRecord {
  return {
    entityId: proposal.proposalId,
    kind: "knowledge_proposal",
    revision: requiredTarget(locked, proposal.proposalId).nextRevision,
    schemaVersion: "knowledge-proposal.r7.v1",
    eventType: "entity.updated",
    snapshot: { ...proposal, status: decision.decision },
    eventData: { decision: decision.decision },
    result: { proposalId: proposal.proposalId, reviewId, targetId: proposal.targetId },
  }
}

export function reviewRecord(
  proposal: StoredProposal,
  decision: DecideKnowledgeProposal,
  policy: KnowledgeReviewPolicy,
  reviewId: string,
  reviewedAt: string,
): MutationRecord {
  return {
    entityId: reviewId,
    kind: "knowledge_review",
    revision: 1,
    schemaVersion: "knowledge-review.r7.v1",
    eventType: "entity.created",
    snapshot: {
      proposalId: proposal.proposalId,
      proposalRevision: proposal.revision,
      subjectId: proposal.targetId,
      subjectRevision: proposal.baseRevision,
      decision: decision.decision,
      policyId: policy.id,
      policyRevision: policy.revision,
      reviewedAt,
    },
    eventData: { proposalId: proposal.proposalId, decision: decision.decision },
    result: { proposalId: proposal.proposalId, reviewId, targetId: proposal.targetId },
  }
}

export function requiredTarget(
  targets: ReadonlyMap<string, LockedCommandTarget>,
  id: string,
): LockedCommandTarget {
  const target = targets.get(id)
  if (target === undefined) throw new CommandInvariantError("locked_target_missing")
  return target
}
