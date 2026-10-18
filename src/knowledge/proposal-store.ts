import type { TransactionSql } from "postgres"
import { z } from "zod"
import {
  type CreateKnowledgeProposal,
  CreateKnowledgeProposalSchema,
  type ProposalRelation,
  type ProposalSource,
} from "../contracts/knowledge/index.ts"
import { toJsonValue } from "../entities/command-unit-of-work-support.ts"
import { EntityNotFoundError } from "../entities/errors.ts"

const ProposalRowSchema = z.strictObject({
  id: z.string(),
  target_id: z.string(),
  base_revision: z.coerce.number().int().positive().nullable(),
  action: z.enum(["knowledge.create", "knowledge.revise"]),
  candidate_payload: z.unknown(),
  status: z.enum(["pending", "accepted", "rejected", "changes_requested"]),
  revision: z.coerce.number().int().positive(),
  profile_id: z.string().nullable(),
  profile_revision: z.coerce.number().int().positive().nullable(),
  input_revision: z.coerce.number().int().positive().nullable(),
})
const SourceRowSchema = z.strictObject({
  source_kind: z.enum(["entity", "runtime_artifact"]),
  source_entity_id: z.string().nullable(),
  source_revision: z.coerce.number().int().positive().nullable(),
  artifact_id: z.string().nullable(),
  evidence_role: z.enum(["supporting", "contradicting", "context"]),
})
const RelationRowSchema = z.strictObject({
  related_entity_id: z.string(),
  related_revision: z.coerce.number().int().positive(),
  relation_type: z.enum(["supports", "contradicts", "answers", "supersedes", "applies_to"]),
})

export type StoredProposal = CreateKnowledgeProposal & {
  readonly proposalId: string
  readonly status: "pending" | "accepted" | "rejected" | "changes_requested"
  readonly revision: number
}

export async function insertProposal(
  transaction: TransactionSql,
  proposalId: string,
  workspaceId: string,
  proposerId: string,
  value: CreateKnowledgeProposal,
): Promise<void> {
  await transaction`insert into knowledge_proposals
    (id,workspace_id,target_id,base_revision,action,candidate_type,candidate_payload,
      profile_id,profile_revision,input_revision,status,proposer_id,revision,created_at)
      values (${proposalId},${workspaceId},${value.targetId},
      ${value.baseRevision},${value.action},${value.candidate.type},
      ${transaction.json(toJsonValue(value.candidate))},${value.profileId},${value.profileRevision},
      ${value.inputRevision},'pending',${proposerId},1,clock_timestamp())`
  for (const [ordinal, source] of value.sources.entries()) {
    await transaction`insert into knowledge_proposal_sources
      (proposal_id,ordinal,source_kind,source_entity_id,source_revision,artifact_id,evidence_role)
      values (${proposalId},${ordinal},${source.kind},
        ${source.kind === "entity" ? source.entityId : null},
        ${source.kind === "entity" ? source.revision : null},
        ${source.kind === "runtime_artifact" ? source.artifactId : null},${source.role})`
  }
  for (const relation of value.relations) {
    await transaction`insert into knowledge_proposal_relations
      (proposal_id,related_entity_id,related_revision,relation_type)
      values (${proposalId},${relation.entityId},${relation.revision},${relation.type})`
  }
}

export async function loadProposal(
  transaction: TransactionSql,
  workspaceId: string,
  proposalId: string,
): Promise<StoredProposal> {
  const rows =
    await transaction`select p.id,p.target_id,p.base_revision,p.action,p.candidate_payload,
      p.status,p.revision,p.profile_id,p.profile_revision,p.input_revision
    from knowledge_proposals p
    where p.workspace_id=${workspaceId} and p.id=${proposalId}`
  const rowValue = rows[0]
  if (rowValue === undefined) throw new EntityNotFoundError(proposalId)
  const row = ProposalRowSchema.parse(rowValue)
  const sourceRows =
    await transaction`select source_kind,source_entity_id,source_revision,artifact_id,
    evidence_role from knowledge_proposal_sources where proposal_id=${proposalId} order by ordinal`
  const relationRows = await transaction`select related_entity_id,related_revision,relation_type
    from knowledge_proposal_relations where proposal_id=${proposalId} order by related_entity_id,relation_type`
  const sources = sourceRows.map(sourceFromRow)
  const relations = relationRows.map(relationFromRow)
  const value = CreateKnowledgeProposalSchema.parse({
    targetId: row.target_id,
    action: row.action,
    baseRevision: row.base_revision,
    candidate: row.candidate_payload,
    sources,
    relations,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    inputRevision: row.input_revision,
  })
  return { ...value, proposalId: row.id, status: row.status, revision: row.revision }
}

function sourceFromRow(value: unknown): ProposalSource {
  const row = SourceRowSchema.parse(value)
  if (row.source_kind === "entity") {
    if (row.source_entity_id === null || row.source_revision === null)
      throw new TypeError("invalid entity source")
    return {
      kind: "entity",
      entityId: row.source_entity_id,
      revision: row.source_revision,
      role: row.evidence_role,
    }
  }
  if (row.artifact_id === null) throw new TypeError("invalid artifact source")
  return { kind: "runtime_artifact", artifactId: row.artifact_id, role: row.evidence_role }
}

function relationFromRow(value: unknown): ProposalRelation {
  const row = RelationRowSchema.parse(value)
  return {
    entityId: row.related_entity_id,
    revision: row.related_revision,
    type: row.relation_type,
  }
}
