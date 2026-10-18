import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import type {
  CreateKnowledgeProposal,
  KnowledgeCandidate,
} from "../src/contracts/knowledge/index.ts"
import { EntityRevisionConflictError } from "../src/entities/errors.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { ALL_WORK_PERMISSIONS, type AuthenticatedPrincipal } from "../src/identity/types.ts"
import { KnowledgeCommandService } from "../src/knowledge/command-service.ts"
import { KnowledgeReader } from "../src/knowledge/reader.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

const ResultSchema = z.strictObject({
  proposalId: z.string(),
  targetId: z.string(),
  reviewId: z.string().optional(),
})
let fixture: UnmigratedPostgresTestFixture
let principal: AuthenticatedPrincipal
let service: KnowledgeCommandService
let sequence: number

beforeEach(async () => {
  fixture = await createUnmigratedPostgresTestFixture()
  await migrateDatabase(fixture.sql)
  const admin = new IdentityAdmin(fixture.sql)
  const issued = await admin.bootstrapWorkspace({
    workspaceId: "workspace",
    workspaceName: "Workspace",
    principalId: "owner",
    principalName: "Owner",
    expiresAt: "2030-01-01T00:00:00.000Z",
  })
  await admin.setPermissions({
    workspaceId: "workspace",
    principalId: "owner",
    permissions: [...ALL_WORK_PERMISSIONS],
  })
  const authenticated = await authenticateToken(fixture.sql, issued.token)
  if (authenticated === undefined) throw new TypeError("fixture authentication failed")
  principal = authenticated
  sequence = 0
  service = new KnowledgeCommandService(fixture.sql, {
    newProposalId: () => `proposal-${++sequence}`,
    newReviewId: () => `review-${++sequence}`,
  })
})

afterEach(async () => fixture.close())

test("accepted proposal atomically creates canonical knowledge with pinned provenance", async () => {
  // Given
  const source = await createAccepted("source", claim("Source statement"))
  const proposal = await propose({
    targetId: "target",
    action: "knowledge.create",
    baseRevision: null,
    candidate: claim("Target statement"),
    sources: [{ kind: "entity", entityId: source.targetId, revision: 1, role: "supporting" }],
    relations: [{ entityId: source.targetId, revision: 1, type: "supports" }],
    profileId: "profile",
    profileRevision: 3,
    inputRevision: 7,
  })

  // When
  const accepted = await decide(proposal.proposalId, 1, "accepted")

  // Then
  const canonical = await new KnowledgeReader(fixture.sql, principal).get("workspace", "target")
  assert.equal(canonical?.revision, 1)
  assert.equal(canonical?.candidate.type, "claim")
  const sourcePin = canonical?.sources[0]
  assert.equal(sourcePin?.kind === "entity" ? sourcePin.revision : undefined, 1)
  assert.equal(canonical?.relations[0]?.revision, 1)
  const rows = await fixture.sql`select p.status,r.proposal_revision,r.subject_revision,
    r.policy_id,r.policy_revision::integer,
    r.profile_id,r.profile_revision::integer,r.input_revision::integer
    from knowledge_proposals p join knowledge_reviews r on r.proposal_id=p.id
    where p.id=${proposal.proposalId}`
  assert.deepEqual(
    [...rows],
    [
      {
        status: "accepted",
        proposal_revision: "1",
        subject_revision: null,
        policy_id: "human-review",
        policy_revision: 1,
        profile_id: "profile",
        profile_revision: 3,
        input_revision: 7,
      },
    ],
  )
  assert.equal(accepted.reviewId?.startsWith("review-"), true)
})

test("rejected and changes-requested reviews leave canonical revision unchanged", async () => {
  // Given
  await createAccepted("subject", claim("Original"))
  const rejected = await propose(revisionProposal("subject", 1, claim("Rejected")))
  const changes = await propose(revisionProposal("subject", 1, claim("Needs changes")))

  // When
  await decide(rejected.proposalId, 1, "rejected")
  await decide(changes.proposalId, 1, "changes_requested")

  // Then
  const subject = await new KnowledgeReader(fixture.sql, principal).get("workspace", "subject")
  assert.equal(subject?.revision, 1)
  assert.equal(subject?.candidate.type === "claim" ? subject.candidate.statement : "", "Original")
})

test("stale approval rolls back review and proposal decision", async () => {
  // Given
  await createAccepted("subject", claim("Revision one"))
  const first = await propose(revisionProposal("subject", 1, claim("Revision two")))
  const stale = await propose(revisionProposal("subject", 1, claim("Stale revision")))
  await decide(first.proposalId, 1, "accepted")

  // When / Then
  await assert.rejects(decide(stale.proposalId, 1, "accepted"), EntityRevisionConflictError)
  const rows = await fixture.sql`select status,
    (select count(*)::integer from knowledge_reviews where proposal_id=${stale.proposalId}) reviews
    from knowledge_proposals where id=${stale.proposalId}`
  assert.deepEqual([...rows], [{ status: "pending", reviews: 0 }])
})

test("source revision marks a derived summary stale while preserving pinned history", async () => {
  // Given
  await createAccepted("source", claim("Revision one"))
  await fixture.sql`insert into derived_summaries
    (workspace_id,subject_id,source_entity_id,source_revision,profile_id,profile_revision,
      generator,content,token_count) values
    ('workspace','source','source',1,'brief',1,'test','summary',1)`
  const proposal = await propose(revisionProposal("source", 1, claim("Revision two")))

  // When
  await decide(proposal.proposalId, 1, "accepted")

  // Then
  const reader = new KnowledgeReader(fixture.sql, principal)
  const summaries = await reader.summaries("workspace", "source")
  const history = await reader.history("workspace", "source")
  assert.equal(summaries[0]?.fresh, false)
  assert.deepEqual(
    history.map((entry) => entry.revision),
    [2, 1],
  )
})

async function createAccepted(targetId: string, candidate: KnowledgeCandidate) {
  const proposal = await propose({
    targetId,
    action: "knowledge.create",
    baseRevision: null,
    candidate,
    sources: [],
    relations: [],
    profileId: null,
    profileRevision: null,
    inputRevision: null,
  })
  await decide(proposal.proposalId, 1, "accepted")
  return proposal
}

async function propose(payload: CreateKnowledgeProposal) {
  const result = await service.execute(call("knowledge.proposal.create", null, payload))
  return ResultSchema.parse(result.result)
}

async function decide(
  proposalId: string,
  revision: number,
  decision: "accepted" | "rejected" | "changes_requested",
) {
  const result = await service.execute(
    call(
      "knowledge.review.decide",
      revision,
      {
        decision,
        rationale: "reviewed",
        policyId: "human-review",
        policyRevision: 1,
      },
      proposalId,
    ),
  )
  return ResultSchema.parse(result.result)
}

function call(
  action: "knowledge.proposal.create" | "knowledge.review.decide",
  baseRevision: number | null,
  payload: unknown,
  resourceId: string | null = null,
) {
  const id = ++sequence
  return {
    workspaceId: "workspace",
    principal,
    commandId: `command-${id}`,
    idempotencyKey: `knowledge-${id}`,
    baseRevision,
    action,
    route: "test",
    resourceId,
    parentId: null,
    payload,
  }
}

function claim(statement: string): KnowledgeCandidate {
  return {
    type: "claim",
    title: statement,
    statement,
    status: "accepted",
    confidence: 0.9,
    validityScope: "workspace",
  }
}

function revisionProposal(
  targetId: string,
  baseRevision: number,
  candidate: KnowledgeCandidate,
): CreateKnowledgeProposal {
  return {
    targetId,
    action: "knowledge.revise",
    baseRevision,
    candidate,
    sources: [],
    relations: [],
    profileId: null,
    profileRevision: null,
    inputRevision: null,
  }
}
