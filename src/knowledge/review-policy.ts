import type { TransactionSql } from "postgres"
import { z } from "zod"
import {
  BUILT_IN_KNOWLEDGE_REVIEW_POLICY,
  type DecideKnowledgeProposal,
} from "../contracts/knowledge/index.ts"
import { CommandInvariantError } from "../entities/errors.ts"

const ReviewPolicyRowSchema = z.strictObject({
  policy_id: z.string(),
  revision: z.coerce.number().int().positive(),
})

export type KnowledgeReviewPolicy = {
  readonly id: string
  readonly revision: number
}

export async function resolveKnowledgeReviewPolicy(
  transaction: TransactionSql,
  requested: DecideKnowledgeProposal,
): Promise<KnowledgeReviewPolicy> {
  const rows = await transaction`select policy_id,revision from knowledge_review_policies
    where policy_id=${BUILT_IN_KNOWLEDGE_REVIEW_POLICY.id}
      and revision=${BUILT_IN_KNOWLEDGE_REVIEW_POLICY.revision}
      and policy_type='human_approval'`
  const value = rows[0]
  if (value === undefined) throw new CommandInvariantError("knowledge_review_policy_unavailable")
  const policy = ReviewPolicyRowSchema.parse(value)
  if (requested.policyId !== policy.policy_id || requested.policyRevision !== policy.revision) {
    throw new CommandInvariantError("knowledge_review_policy_mismatch")
  }
  return { id: policy.policy_id, revision: policy.revision }
}
