import type { TransactionSql } from "postgres"
import type { KnowledgeCandidate } from "../contracts/knowledge/index.ts"
import { CommandInvariantError } from "../entities/errors.ts"
import type { MutationRecord } from "../entities/mutation-types.ts"
import { insertEntity, linkEntityAccessDependency } from "../entities/registry.ts"
import type { DomainProposalApplier, ProposalApplication } from "./applier-registry.ts"
import { assertNever, persistRevisionProvenance } from "./provenance.ts"

export class KnowledgeObjectApplier implements DomainProposalApplier {
  readonly actions = ["knowledge.create", "knowledge.revise"] as const

  async apply(input: ProposalApplication): Promise<MutationRecord> {
    if (input.action === "knowledge.create") await createObject(input)
    else if (input.action === "knowledge.revise") await updateObject(input)
    else throw new CommandInvariantError("unsupported_knowledge_action")
    await persistSubtype(input.transaction, input.targetId, input.candidate, input)
    for (const source of input.sources) {
      if (source.kind === "entity") {
        await linkEntityAccessDependency(input.transaction, input.targetId, source.entityId)
      }
    }
    for (const relation of input.relations) {
      await linkEntityAccessDependency(input.transaction, input.targetId, relation.entityId)
    }
    await persistRevisionProvenance(input.transaction, {
      knowledgeId: input.targetId,
      revision: input.revision,
      proposalId: input.proposalId,
      reviewId: input.reviewId,
      sources: input.sources,
      relations: input.relations,
    })
    return {
      entityId: input.targetId,
      kind: "knowledge_object",
      revision: input.revision,
      schemaVersion: "knowledge-object.r7.v1",
      eventType: input.revision === 1 ? "entity.created" : "entity.updated",
      snapshot: snapshot(input),
      eventData: { proposalId: input.proposalId, reviewId: input.reviewId },
      result: { proposalId: input.proposalId, reviewId: input.reviewId, targetId: input.targetId },
    }
  }
}

async function createObject(input: ProposalApplication): Promise<void> {
  await insertEntity(input.transaction, {
    id: input.targetId,
    workspaceId: input.principal.workspaceId,
    kind: "knowledge_object",
    scopeSpaceId: null,
    actorId: input.principal.principalId,
  })
  await input.transaction`insert into knowledge_objects
    (id,workspace_id,object_type,title,lifecycle,current_revision,accepted_proposal_id,
      accepted_review_id,reviewed_by,reviewed_at,search_text,created_at,updated_at)
    values (${input.targetId},${input.principal.workspaceId},${input.candidate.type},
      ${input.candidate.title},'active',${input.revision},${input.proposalId},${input.reviewId},
      ${input.principal.principalId},${input.reviewedAt},${JSON.stringify(input.candidate)},
      ${input.reviewedAt},${input.reviewedAt})`
}

async function updateObject(input: ProposalApplication): Promise<void> {
  const rows = await input.transaction`update knowledge_objects set title=${input.candidate.title},
    current_revision=${input.revision},accepted_proposal_id=${input.proposalId},
    accepted_review_id=${input.reviewId},reviewed_by=${input.principal.principalId},
    reviewed_at=${input.reviewedAt},search_text=${JSON.stringify(input.candidate)},
    updated_at=${input.reviewedAt} where workspace_id=${input.principal.workspaceId}
      and id=${input.targetId} and object_type=${input.candidate.type} returning id`
  if (rows.length !== 1) throw new CommandInvariantError("knowledge_type_change_forbidden")
}

async function persistSubtype(
  transaction: TransactionSql,
  id: string,
  candidate: KnowledgeCandidate,
  input: ProposalApplication,
): Promise<void> {
  switch (candidate.type) {
    case "claim":
      await transaction`insert into knowledge_claims
        (id,statement,status,confidence,validity_scope,reviewed_by,reviewed_at)
        values (${id},${candidate.statement},${candidate.status},${candidate.confidence},
          ${candidate.validityScope},${input.principal.principalId},${input.reviewedAt})
        on conflict (id) do update set statement=excluded.statement,status=excluded.status,
          confidence=excluded.confidence,validity_scope=excluded.validity_scope,
          reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at`
      return
    case "decision":
      await transaction`insert into knowledge_decisions
        (id,decision,context,alternatives,rationale,consequences,status,owner_id,review_date,applies_to)
        values (${id},${candidate.decision},${candidate.context},${candidate.alternatives},
          ${candidate.rationale},${candidate.consequences},${candidate.status},${candidate.ownerId},
          ${candidate.reviewDate},${candidate.appliesTo}) on conflict (id) do update set
          decision=excluded.decision,context=excluded.context,alternatives=excluded.alternatives,
          rationale=excluded.rationale,consequences=excluded.consequences,status=excluded.status,
          owner_id=excluded.owner_id,review_date=excluded.review_date,applies_to=excluded.applies_to`
      return
    case "evidence":
      await transaction`insert into knowledge_evidence
        (id,source_type,source_ref,observation,captured_at,captured_by,reliability,validity)
        values (${id},${candidate.sourceType},${candidate.sourceRef},${candidate.observation},
          ${candidate.capturedAt},${candidate.capturedBy},${candidate.reliability},${candidate.validity})
        on conflict (id) do update set source_type=excluded.source_type,source_ref=excluded.source_ref,
          observation=excluded.observation,captured_at=excluded.captured_at,
          captured_by=excluded.captured_by,reliability=excluded.reliability,validity=excluded.validity`
      return
    case "question":
      await transaction`insert into knowledge_questions
        (id,question,status,owner_id,delegates,accepted_answer_id) values
        (${id},${candidate.question},${candidate.status},${candidate.ownerId},
          ${transaction.json(candidate.delegates)},${candidate.acceptedAnswerId})
        on conflict (id) do update set question=excluded.question,status=excluded.status,
          owner_id=excluded.owner_id,delegates=excluded.delegates,
          accepted_answer_id=excluded.accepted_answer_id`
      return
    case "experiment":
      await transaction`insert into knowledge_experiments
        (id,hypothesis,method,inputs,runs,results,conclusion) values
        (${id},${candidate.hypothesis},${candidate.method},${candidate.inputs},${candidate.runs},
          ${candidate.results},${candidate.conclusion}) on conflict (id) do update set
          hypothesis=excluded.hypothesis,method=excluded.method,inputs=excluded.inputs,
          runs=excluded.runs,results=excluded.results,conclusion=excluded.conclusion`
      return
    default:
      assertNever(candidate)
  }
}

function snapshot(input: ProposalApplication) {
  return {
    candidate: input.candidate,
    acceptedProposalId: input.proposalId,
    acceptedReviewId: input.reviewId,
    sources: input.sources,
    relations: input.relations,
  }
}
