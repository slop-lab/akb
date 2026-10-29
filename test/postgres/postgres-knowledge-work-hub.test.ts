import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { z } from "zod"
import { WorkHubPostgresFixture } from "../knowledge-work-hub-postgres-fixture.ts"

const CommandResultSchema = z.object({
  replayed: z.boolean(),
  result: z.strictObject({
    proposalId: z.string().optional(),
    targetId: z.string().optional(),
    reviewId: z.string().optional(),
  }),
})
const ProposalDetailSchema = z.strictObject({
  proposal: z.object({
    proposalId: z.string(),
    status: z.enum(["pending", "accepted", "rejected", "changes_requested"]),
    proposerId: z.string(),
    createdAt: z.iso.datetime(),
    sources: z.array(z.unknown()),
  }),
})
let fixture: WorkHubPostgresFixture

before(async () => {
  fixture = await WorkHubPostgresFixture.create()
})

after(async () => fixture.close())

test("Work Hub reads an exact Page revision and a reviewer accepts preserved external provenance", async () => {
  // Given
  await fixture.contentCommand("/pages", "POST", null, {
    pageId: "context-page",
    title: "Task context",
    document: document("Immutable context"),
  })
  await fixture.contentCommand("/pages/context-page", "PATCH", 1, {
    document: document("Later edit"),
  })
  const exactPage = await fixture.get(
    "/api/content/v1/workspaces/workspace/pages/context-page/revisions/1",
    fixture.connectorToken,
  )
  assert.equal(exactPage.status, 200)
  assert.equal(
    z
      .object({
        page: z.object({
          revision: z.literal(1),
          document: z.object({ blocks: z.array(z.object({ text: z.string() })) }),
        }),
      })
      .parse(JSON.parse(exactPage.body)).page.document.blocks[0]?.text,
    "Immutable context",
  )
  assert.equal(
    (
      await fixture.get(
        "/api/content/v1/workspaces/workspace/pages/context-page/revisions/999",
        fixture.connectorToken,
      )
    ).status,
    404,
  )
  const proposalPayload = {
    targetId: "work-hub-result",
    action: "knowledge.create",
    baseRevision: null,
    candidate: claim("Implemented connector result"),
    sources: [
      { kind: "entity", entityId: "context-page", revision: 1, role: "context" },
      {
        kind: "external",
        serviceInstanceId: "work-hub:local",
        resourceKind: "result",
        resourceId: "result-42",
        version: { kind: "digest", algorithm: "sha256", value: "a".repeat(64) },
        permalink: "https://work-hub.example.test/results/result-42",
        excerpt: "Connector tests passed.",
        role: "supporting",
      },
    ],
    relations: [],
    profileId: null,
    profileRevision: null,
    inputRevision: null,
  }
  const envelope = fixture.commandEnvelope(null, proposalPayload)

  // When
  const first = await fixture.post(
    "/api/knowledge/v1/workspaces/workspace/proposals",
    fixture.connectorToken,
    envelope,
  )
  const replay = await fixture.post(
    "/api/knowledge/v1/workspaces/workspace/proposals",
    fixture.connectorToken,
    envelope,
  )
  const conflict = await fixture.post(
    "/api/knowledge/v1/workspaces/workspace/proposals",
    fixture.connectorToken,
    fixture.replaceCommandPayload(envelope, {
      ...proposalPayload,
      candidate: claim("Changed connector result"),
    }),
  )
  const proposalId = CommandResultSchema.parse(JSON.parse(first.body)).result.proposalId
  if (proposalId === undefined) throw new TypeError("proposal id missing")
  const inbox = await fixture.get(
    "/api/knowledge/v1/workspaces/workspace/proposals?status=pending&limit=10",
    fixture.reviewerToken,
  )
  const detail = await fixture.get(
    `/api/knowledge/v1/workspaces/workspace/proposals/${encodeURIComponent(proposalId)}`,
    fixture.reviewerToken,
  )

  // Then
  assert.equal(first.status, 201)
  assert.equal(replay.status, 200)
  assert.equal(conflict.status, 409, conflict.body)
  assert.equal(CommandResultSchema.parse(JSON.parse(replay.body)).replayed, true)
  assert.equal(inbox.status, 200, inbox.body)
  assert.equal(detail.status, 200, detail.body)
  assert.deepEqual(
    z
      .object({ proposals: z.array(z.object({ proposalId: z.string() })) })
      .parse(JSON.parse(inbox.body))
      .proposals.map((proposal) => proposal.proposalId),
    [proposalId],
  )
  const stored = ProposalDetailSchema.parse(JSON.parse(detail.body)).proposal
  assert.equal(stored.proposerId, "work-hub")
  assert.equal(stored.sources.length, 2)
  const reviewPath = `/api/knowledge/v1/workspaces/workspace/proposals/${encodeURIComponent(proposalId)}/reviews`
  const reviewEnvelope = fixture.commandEnvelope(1, {
    decision: "accepted",
    rationale: "Human approved",
    policyId: "human-review",
    policyRevision: 1,
  })
  const accepted = await fixture.post(reviewPath, fixture.reviewerToken, reviewEnvelope)
  const acceptedReplay = await fixture.post(reviewPath, fixture.reviewerToken, reviewEnvelope)
  assert.equal(accepted.status, 200)
  assert.equal(acceptedReplay.status, 200, acceptedReplay.body)
  assert.equal(CommandResultSchema.parse(JSON.parse(acceptedReplay.body)).replayed, true)
  const revision = await fixture.get(
    "/api/knowledge/v1/workspaces/workspace/objects/work-hub-result/revisions/1",
    fixture.reviewerToken,
  )
  const acceptedObject = z
    .object({ revision: z.literal(1), sources: z.array(z.unknown()) })
    .parse(JSON.parse(revision.body))
  assert.equal(acceptedObject.sources.length, 2)
  assert.deepEqual(acceptedObject.sources[1], stored.sources[1])
  assert.equal(
    (
      await fixture.get(
        "/api/knowledge/v1/workspaces/workspace/objects/work-hub-result/revisions/999",
        fixture.reviewerToken,
      )
    ).status,
    404,
  )
  await fixture.admin.setPermissions({
    workspaceId: "workspace",
    principalId: "reviewer",
    permissions: ["knowledge.read", "knowledge.accept", "review.read", "review.decide"],
  })
  assert.equal((await fixture.post(reviewPath, fixture.reviewerToken, reviewEnvelope)).status, 404)
  await fixture.admin.setPermissions({
    workspaceId: "workspace",
    principalId: "reviewer",
    permissions: [
      "content.read",
      "knowledge.read",
      "knowledge.accept",
      "review.read",
      "review.decide",
    ],
  })
})

test("exact revision and proposal reads enforce workspace, grants, and dependency revocation", async () => {
  // Given
  assert.equal(
    (
      await fixture.get(
        "/api/knowledge/v1/workspaces/other/proposals?status=pending",
        fixture.reviewerToken,
      )
    ).status,
    404,
  )

  // When
  await fixture.admin.setPermissions({
    workspaceId: "workspace",
    principalId: "work-hub",
    permissions: ["knowledge.read", "knowledge.propose"],
  })
  await fixture.admin.setPermissions({
    workspaceId: "workspace",
    principalId: "reviewer",
    permissions: ["knowledge.read", "knowledge.accept", "review.read", "review.decide"],
  })

  // Then
  assert.equal(
    z
      .object({ proposals: z.array(z.unknown()) })
      .parse(
        JSON.parse(
          (
            await fixture.get(
              "/api/knowledge/v1/workspaces/workspace/proposals?status=accepted",
              fixture.reviewerToken,
            )
          ).body,
        ),
      ).proposals.length,
    0,
  )
  await fixture.admin.setPermissions({
    workspaceId: "workspace",
    principalId: "reviewer",
    permissions: ["knowledge.read", "knowledge.accept", "review.decide"],
  })
  assert.equal(
    (
      await fixture.get(
        "/api/content/v1/workspaces/workspace/pages/context-page/revisions/1",
        fixture.connectorToken,
      )
    ).status,
    404,
  )
  assert.equal(
    (
      await fixture.get(
        "/api/knowledge/v1/workspaces/workspace/proposals?status=accepted",
        fixture.reviewerToken,
      )
    ).status,
    404,
  )
})

function document(text: string) {
  return { version: 1, blocks: [{ id: "body", type: "paragraph", text, children: [] }] }
}

function claim(statement: string) {
  return {
    type: "claim",
    title: statement,
    statement,
    status: "accepted",
    confidence: 1,
    validityScope: "workspace",
  }
}
