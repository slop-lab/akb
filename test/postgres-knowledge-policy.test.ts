import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { authenticateToken } from "../src/identity/authenticate.ts"
import { ALL_WORK_PERMISSIONS, type AuthenticatedPrincipal } from "../src/identity/types.ts"
import { KnowledgeCommandService } from "../src/knowledge/command-service.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"

const ResultSchema = z.strictObject({ proposalId: z.string(), targetId: z.string() })
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
    newProposalId: () => `policy-proposal-${++sequence}`,
    newReviewId: () => `policy-review-${++sequence}`,
  })
})

afterEach(async () => fixture.close())

test("unknown review policy approval rolls back every knowledge mutation", async () => {
  // Given
  const proposal = await createProposal("unknown-policy-target")

  // When / Then
  await assert.rejects(decide(proposal.proposalId, "attacker-selected-policy", 99))
  const rows = await fixture.sql`select status,
    (select count(*)::integer from knowledge_reviews where proposal_id=${proposal.proposalId}) reviews,
    (select count(*)::integer from knowledge_objects where id='unknown-policy-target') canonical
    from knowledge_proposals where id=${proposal.proposalId}`
  assert.deepEqual([...rows], [{ status: "pending", reviews: 0, canonical: 0 }])
})

test("registered alternate policy cannot override the server-required approval policy", async () => {
  // Given
  await fixture.sql`insert into knowledge_review_policies
    (policy_id,revision,policy_type,display_name)
    values ('alternate-review',7,'human_approval','Alternate review')`
  const proposal = await createProposal("alternate-policy-target")

  // When / Then
  await assert.rejects(decide(proposal.proposalId, "alternate-review", 7))
  const rows = await fixture.sql`select status,
    (select count(*)::integer from knowledge_reviews where proposal_id=${proposal.proposalId}) reviews,
    (select count(*)::integer from knowledge_objects where id='alternate-policy-target') canonical
    from knowledge_proposals where id=${proposal.proposalId}`
  assert.deepEqual([...rows], [{ status: "pending", reviews: 0, canonical: 0 }])
})

async function createProposal(targetId: string) {
  const result = await service.execute(
    command("knowledge.proposal.create", null, null, {
      targetId,
      action: "knowledge.create",
      baseRevision: null,
      candidate: {
        type: "claim",
        title: "Policy protected knowledge",
        statement: "Policy protected knowledge",
        status: "accepted",
        confidence: 1,
        validityScope: "workspace",
      },
      sources: [],
      relations: [],
      profileId: null,
      profileRevision: null,
      inputRevision: null,
    }),
  )
  return ResultSchema.parse(result.result)
}

async function decide(proposalId: string, policyId: string, policyRevision: number) {
  return service.execute(
    command("knowledge.review.decide", proposalId, 1, {
      decision: "accepted",
      rationale: "reviewed",
      policyId,
      policyRevision,
    }),
  )
}

function command(
  action: "knowledge.proposal.create" | "knowledge.review.decide",
  resourceId: string | null,
  baseRevision: number | null,
  payload: unknown,
) {
  const id = ++sequence
  return {
    workspaceId: "workspace",
    principal,
    commandId: `policy-command-${id}`,
    idempotencyKey: `policy-${id}`,
    baseRevision,
    action,
    route: "test",
    resourceId,
    parentId: null,
    payload,
  }
}
