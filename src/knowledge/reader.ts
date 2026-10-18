import type { Sql, TransactionSql } from "postgres"
import { z } from "zod"
import {
  type DerivedSummary,
  DerivedSummarySchema,
  type KnowledgeHistoryEntry,
  KnowledgeHistoryEntrySchema,
  type KnowledgeObject,
  KnowledgeObjectSchema,
  ProposalRelationSchema,
  ProposalSourceSchema,
} from "../contracts/knowledge/index.ts"
import { EntityNotFoundError } from "../entities/errors.ts"
import { lockAuthenticatedPrincipal } from "../identity/authenticate.ts"
import {
  AuthenticationRequiredError,
  WorkspaceNotFoundError,
} from "../identity/authorization-errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"

const CurrentRowSchema = z.strictObject({
  id: z.string(),
  current_revision: z.coerce.number().int().positive(),
  lifecycle: z.enum(["active", "archived"]),
  accepted_proposal_id: z.string(),
  accepted_review_id: z.string(),
  reviewed_by: z.string(),
  reviewed_at: z.date(),
  canonical_snapshot: z.unknown(),
})
const SnapshotSchema = z.strictObject({
  candidate: KnowledgeObjectSchema.shape.candidate,
  acceptedProposalId: z.string(),
  acceptedReviewId: z.string(),
  sources: z.array(ProposalSourceSchema),
  relations: z.array(ProposalRelationSchema),
})
const HistoryRowSchema = z.strictObject({
  revision: z.coerce.number().int().positive(),
  schema_version: z.string(),
  canonical_snapshot: z.unknown(),
  created_at: z.date(),
})
const SummaryRowSchema = z.strictObject({
  id: z.string().uuid(),
  source_entity_id: z.string(),
  source_revision: z.coerce.number().int().positive(),
  profile_id: z.string(),
  profile_revision: z.coerce.number().int().positive(),
  generator: z.string(),
  content: z.string(),
  token_count: z.number().int().nonnegative(),
  created_at: z.date(),
  stale_at: z.date().nullable(),
})

export class KnowledgeReader {
  readonly #sql: Sql
  readonly #principal: AuthenticatedPrincipal

  constructor(sql: Sql, principal: AuthenticatedPrincipal) {
    this.#sql = sql
    this.#principal = principal
  }

  get(workspaceId: string, knowledgeId: string): Promise<KnowledgeObject | undefined> {
    return this.#sql.begin(async (transaction) => {
      await authorize(transaction, this.#principal, workspaceId, knowledgeId, "knowledge.read")
      const rows = await transaction`select object.id,object.current_revision,object.lifecycle,
          object.accepted_proposal_id,object.accepted_review_id,object.reviewed_by,object.reviewed_at,
          revision.canonical_snapshot
        from knowledge_objects object join entity_revisions revision
          on revision.entity_id=object.id and revision.revision=object.current_revision
        where object.workspace_id=${workspaceId} and object.id=${knowledgeId}`
      const value = rows[0]
      if (value === undefined) return undefined
      const row = CurrentRowSchema.parse(value)
      const snapshot = SnapshotSchema.parse(row.canonical_snapshot)
      return KnowledgeObjectSchema.parse({
        id: row.id,
        revision: row.current_revision,
        lifecycle: row.lifecycle,
        candidate: snapshot.candidate,
        acceptedProposalId: row.accepted_proposal_id,
        acceptedReviewId: row.accepted_review_id,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at.toISOString(),
        sources: snapshot.sources,
        relations: snapshot.relations,
      })
    })
  }

  history(workspaceId: string, knowledgeId: string): Promise<readonly KnowledgeHistoryEntry[]> {
    return this.#sql.begin(async (transaction) => {
      await authorize(transaction, this.#principal, workspaceId, knowledgeId, "knowledge.read")
      const rows = await transaction`select revision,schema_version,canonical_snapshot,created_at
        from entity_revisions where entity_id=${knowledgeId}
          and schema_version='knowledge-object.r7.v1' order by revision desc`
      return rows.map((value) => {
        const row = HistoryRowSchema.parse(value)
        const snapshot = SnapshotSchema.parse(row.canonical_snapshot)
        return KnowledgeHistoryEntrySchema.parse({
          revision: row.revision,
          schemaVersion: row.schema_version,
          candidate: snapshot.candidate,
          acceptedProposalId: snapshot.acceptedProposalId,
          acceptedReviewId: snapshot.acceptedReviewId,
          createdAt: row.created_at.toISOString(),
        })
      })
    })
  }

  summaries(workspaceId: string, knowledgeId: string): Promise<readonly DerivedSummary[]> {
    return this.#sql.begin(async (transaction) => {
      await authorize(transaction, this.#principal, workspaceId, knowledgeId, "knowledge.read")
      const rows = await transaction`select id::text,source_entity_id,source_revision,profile_id,
          profile_revision,generator,content,token_count,created_at,stale_at
        from derived_summaries where workspace_id=${workspaceId} and subject_id=${knowledgeId}
        order by created_at desc,id`
      return rows.map((value) => {
        const row = SummaryRowSchema.parse(value)
        return DerivedSummarySchema.parse({
          id: row.id,
          sourceEntityId: row.source_entity_id,
          sourceRevision: row.source_revision,
          profileId: row.profile_id,
          profileRevision: row.profile_revision,
          generator: row.generator,
          content: row.content,
          tokenCount: row.token_count,
          createdAt: row.created_at.toISOString(),
          staleAt: row.stale_at?.toISOString() ?? null,
          fresh: row.stale_at === null,
        })
      })
    })
  }

  async search(
    workspaceId: string,
    text: string,
    includeSuperseded = false,
    limit = 50,
  ): Promise<readonly KnowledgeObject[]> {
    const ids = await this.#sql.begin(async (transaction) => {
      await authorizeWorkspace(transaction, this.#principal, workspaceId, "knowledge.read")
      return transaction<{ readonly id: string }[]>`select object.id from knowledge_objects object
        where object.workspace_id=${workspaceId} and object.lifecycle='active'
          and entity_access_allowed(object.workspace_id,object.id,${this.#principal.principalId},'knowledge.read')
          and (${text}='' or object.search_document @@ plainto_tsquery('simple',${text}))
          and (${includeSuperseded} or not exists (select 1 from knowledge_claims claim
            where claim.id=object.id and claim.status='superseded'))
          and (${includeSuperseded} or not exists (select 1 from knowledge_decisions decision
            where decision.id=object.id and decision.status in ('superseded','reversed')))
        order by object.updated_at desc,object.id limit ${limit}`
    })
    const objects = await Promise.all(ids.map((row) => this.get(workspaceId, row.id)))
    return objects.filter(isKnowledgeObject)
  }
}

async function authorize(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  workspaceId: string,
  entityId: string,
  permission: "knowledge.read",
): Promise<void> {
  await authorizeWorkspace(transaction, principal, workspaceId, permission)
  const rows = await transaction`select 1 from entities where workspace_id=${workspaceId}
    and id=${entityId} and entity_access_allowed(${workspaceId},id,${principal.principalId},${permission})`
  if (rows.length !== 1) throw new EntityNotFoundError(entityId)
}

async function authorizeWorkspace(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  workspaceId: string,
  permission: "knowledge.read",
): Promise<void> {
  if (!(await lockAuthenticatedPrincipal(transaction, principal)))
    throw new AuthenticationRequiredError()
  if (workspaceId !== principal.workspaceId) throw new WorkspaceNotFoundError()
  const grants =
    await transaction`select 1 from membership_permissions where workspace_id=${workspaceId}
    and principal_id=${principal.principalId} and permission=${permission}`
  if (grants.length !== 1) throw new EntityNotFoundError(workspaceId)
}

function isKnowledgeObject(value: KnowledgeObject | undefined): value is KnowledgeObject {
  return value !== undefined
}
