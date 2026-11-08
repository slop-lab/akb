import type { TransactionSql } from "postgres"
import { z } from "zod"
import {
  type CreateKnowledgeProposal,
  CreateKnowledgeProposalSchema,
  ExternalSourceSchema,
  KnowledgeCandidateSchema,
  type KnowledgeProposal,
  KnowledgeProposalSchema,
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
  proposer_id: z.string(),
  created_at: z.date(),
})
const SourceRowSchema = z.strictObject({
  ordinal: z.coerce.number().int().nonnegative(),
  source_kind: z.enum(["entity", "runtime_artifact"]),
  source_entity_id: z.string().nullable(),
  source_revision: z.coerce.number().int().positive().nullable(),
  artifact_id: z.string().nullable(),
  evidence_role: z.enum(["supporting", "contradicting", "context"]),
})
const StoredProposalPayloadSchema = z.strictObject({
  schemaVersion: z.literal("knowledge-proposal-payload.v2"),
  candidate: KnowledgeCandidateSchema,
  externalSources: z.array(
    z.strictObject({ ordinal: z.number().int().nonnegative(), source: ExternalSourceSchema }),
  ),
})
const RelationRowSchema = z.strictObject({
  related_entity_id: z.string(),
  related_revision: z.coerce.number().int().positive(),
  relation_type: z.enum(["supports", "contradicts", "answers", "supersedes", "applies_to"]),
})

export type StoredProposal = KnowledgeProposal

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
       ${transaction.json(
         toJsonValue({
           schemaVersion: "knowledge-proposal-payload.v2",
           candidate: value.candidate,
           externalSources: value.sources.flatMap((source, ordinal) =>
             source.kind === "external" ? [{ ordinal, source }] : [],
           ),
         }),
       )},${value.profileId},${value.profileRevision},
       ${value.inputRevision},'pending',${proposerId},1,clock_timestamp())`
  for (const [ordinal, source] of value.sources.entries()) {
    if (source.kind === "external") continue
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
      ,p.proposer_id,p.created_at
    from knowledge_proposals p
    where p.workspace_id=${workspaceId} and p.id=${proposalId}`
  const rowValue = rows[0]
  if (rowValue === undefined) throw new EntityNotFoundError(proposalId)
  const row = ProposalRowSchema.parse(rowValue)
  const sourceRows =
    await transaction`select ordinal,source_kind,source_entity_id,source_revision,artifact_id,
    evidence_role from knowledge_proposal_sources where proposal_id=${proposalId} order by ordinal`
  const relationRows = await transaction`select related_entity_id,related_revision,relation_type
    from knowledge_proposal_relations where proposal_id=${proposalId} order by related_entity_id,relation_type`
  const payload = StoredProposalPayloadSchema.safeParse(row.candidate_payload)
  const candidate = payload.success
    ? payload.data.candidate
    : KnowledgeCandidateSchema.parse(row.candidate_payload)
  const internalSources = sourceRows.map(sourceFromRow)
  const externalSources = payload.success ? payload.data.externalSources : []
  const sources = [...internalSources, ...externalSources]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((entry) => entry.source)
  const relations = relationRows.map(relationFromRow)
  const value = CreateKnowledgeProposalSchema.parse({
    targetId: row.target_id,
    action: row.action,
    baseRevision: row.base_revision,
    candidate,
    sources,
    relations,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    inputRevision: row.input_revision,
  })
  return KnowledgeProposalSchema.parse({
    ...value,
    proposalId: row.id,
    status: row.status,
    revision: row.revision,
    proposerId: row.proposer_id,
    createdAt: row.created_at.toISOString(),
  })
}

function sourceFromRow(value: unknown): {
  readonly ordinal: number
  readonly source: ProposalSource
} {
  const row = SourceRowSchema.parse(value)
  if (row.source_kind === "entity") {
    if (row.source_entity_id === null || row.source_revision === null)
      throw new TypeError("invalid entity source")
    return {
      ordinal: row.ordinal,
      source: {
        kind: "entity",
        entityId: row.source_entity_id,
        revision: row.source_revision,
        role: row.evidence_role,
      },
    }
  }
  if (row.artifact_id === null) throw new TypeError("invalid artifact source")
  return {
    ordinal: row.ordinal,
    source: { kind: "runtime_artifact", artifactId: row.artifact_id, role: row.evidence_role },
  }
}

function relationFromRow(value: unknown): ProposalRelation {
  const row = RelationRowSchema.parse(value)
  return {
    entityId: row.related_entity_id,
    revision: row.related_revision,
    type: row.relation_type,
  }
}
