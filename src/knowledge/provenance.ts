import type { TransactionSql } from "postgres"
import type { ProposalRelation, ProposalSource } from "../contracts/knowledge/index.ts"
import { CommandInvariantError, EntityNotFoundError } from "../entities/errors.ts"
import type { AuthenticatedPrincipal } from "../identity/types.ts"

export type ProposalProvenance = {
  readonly sources: readonly ProposalSource[]
  readonly relations: readonly ProposalRelation[]
}

export async function requireAuthorizedProvenance(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  provenance: ProposalProvenance,
): Promise<void> {
  for (const source of provenance.sources) {
    switch (source.kind) {
      case "entity":
        await requireEntityRevision(transaction, principal, source.entityId, source.revision)
        break
      case "runtime_artifact": {
        const rows = await transaction`select 1 from runtime_artifacts artifact
          where artifact.workspace_id=${principal.workspaceId} and artifact.id=${source.artifactId}
            and artifact.complete and exists (select 1 from membership_permissions permission
              where permission.workspace_id=artifact.workspace_id
                and permission.principal_id=${principal.principalId}
                and permission.permission='run.inspect')`
        if (rows.length !== 1) throw new EntityNotFoundError(source.artifactId)
        break
      }
      default:
        assertNever(source)
    }
  }
  for (const relation of provenance.relations) {
    await requireEntityRevision(transaction, principal, relation.entityId, relation.revision)
  }
}

async function requireEntityRevision(
  transaction: TransactionSql,
  principal: AuthenticatedPrincipal,
  entityId: string,
  revision: number,
): Promise<void> {
  const rows = await transaction`select 1 from entities entity
    join entity_kind_registry registry on registry.kind=entity.kind
    join entity_revisions revision on revision.entity_id=entity.id and revision.revision=${revision}
    where entity.workspace_id=${principal.workspaceId} and entity.id=${entityId}
      and entity_access_allowed(entity.workspace_id,entity.id,${principal.principalId},
        registry.read_permission)`
  if (rows.length !== 1) throw new EntityNotFoundError(entityId)
}

export async function persistRevisionProvenance(
  transaction: TransactionSql,
  input: ProposalProvenance & {
    readonly knowledgeId: string
    readonly revision: number
    readonly proposalId: string
    readonly reviewId: string
  },
): Promise<void> {
  for (const [ordinal, source] of input.sources.entries()) {
    const sourceRef = source.kind === "entity" ? source.entityId : source.artifactId
    const sourceRevision = source.kind === "entity" ? source.revision : null
    await transaction`insert into knowledge_revision_sources
      (knowledge_id,revision,ordinal,source_kind,source_ref,source_revision,evidence_role,
        proposal_id,review_id) values (${input.knowledgeId},${input.revision},${ordinal},
        ${source.kind},${sourceRef},${sourceRevision},${source.role},${input.proposalId},
        ${input.reviewId})`
  }
  for (const relation of input.relations) {
    await transaction`insert into knowledge_revision_relations
      (knowledge_id,revision,related_entity_id,related_revision,relation_type,proposal_id,review_id)
      values (${input.knowledgeId},${input.revision},${relation.entityId},${relation.revision},
        ${relation.type},${input.proposalId},${input.reviewId})`
  }
}

export function assertNever(value: never): never {
  throw new CommandInvariantError(`unsupported_variant:${JSON.stringify(value)}`)
}
