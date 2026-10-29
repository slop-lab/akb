import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { z } from "zod"
import { WorkHubPostgresFixture } from "../knowledge-work-hub-postgres-fixture.ts"

const CommandResultSchema = z.object({
  result: z.object({ proposalId: z.string() }),
})
const KnowledgeReadSchema = z.object({
  revision: z.number().int().positive(),
  candidate: z.object({ statement: z.string() }),
  acceptedProposalId: z.string(),
  reviewedBy: z.string(),
  sources: z.array(
    z.object({
      kind: z.literal("external"),
      resourceId: z.string(),
      version: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("revision"), value: z.string() }),
        z.object({ kind: z.literal("digest"), value: z.string() }),
      ]),
    }),
  ),
})

let fixture: WorkHubPostgresFixture

before(async () => {
  fixture = await WorkHubPostgresFixture.create()
})

after(async () => fixture.close())

test("exact Knowledge reads preserve revision one after revision two has different provenance", async () => {
  // Given
  const firstProposalId = await submit({
    targetId: "versioned-knowledge",
    action: "knowledge.create",
    baseRevision: null,
    candidate: claim("Version one"),
    sources: [externalRevisionSource("task-1", "1")],
    relations: [],
    profileId: null,
    profileRevision: null,
    inputRevision: null,
  })
  await accept(firstProposalId)
  const secondProposalId = await submit({
    targetId: "versioned-knowledge",
    action: "knowledge.revise",
    baseRevision: 1,
    candidate: claim("Version two"),
    sources: [externalDigestSource("result-2", "b".repeat(64))],
    relations: [],
    profileId: null,
    profileRevision: null,
    inputRevision: null,
  })
  await accept(secondProposalId)

  // When
  const revisionOne = await read("/objects/versioned-knowledge/revisions/1")
  const revisionTwo = await read("/objects/versioned-knowledge/revisions/2")
  const current = await read("/objects/versioned-knowledge")

  // Then
  assert.equal(revisionOne.revision, 1)
  assert.equal(revisionOne.candidate.statement, "Version one")
  assert.equal(revisionOne.acceptedProposalId, firstProposalId)
  assert.equal(revisionOne.reviewedBy, "reviewer")
  assert.equal(revisionOne.sources[0]?.resourceId, "task-1")
  assert.deepEqual(revisionOne.sources[0]?.version, { kind: "revision", value: "1" })
  assert.equal(revisionTwo.revision, 2)
  assert.equal(revisionTwo.candidate.statement, "Version two")
  assert.equal(revisionTwo.acceptedProposalId, secondProposalId)
  assert.equal(revisionTwo.reviewedBy, "reviewer")
  assert.equal(revisionTwo.sources[0]?.resourceId, "result-2")
  assert.deepEqual(revisionTwo.sources[0]?.version, {
    kind: "digest",
    value: "b".repeat(64),
  })
  assert.deepEqual(current, revisionTwo)
})

async function submit(payload: Readonly<Record<string, unknown>>): Promise<string> {
  const response = await fixture.post(
    "/api/knowledge/v1/workspaces/workspace/proposals",
    fixture.connectorToken,
    fixture.commandEnvelope(null, payload),
  )
  assert.equal(response.status, 201, response.body)
  return CommandResultSchema.parse(JSON.parse(response.body)).result.proposalId
}

async function accept(proposalId: string): Promise<void> {
  const response = await fixture.post(
    `/api/knowledge/v1/workspaces/workspace/proposals/${encodeURIComponent(proposalId)}/reviews`,
    fixture.reviewerToken,
    fixture.commandEnvelope(1, {
      decision: "accepted",
      rationale: "Human approved exact revision",
      policyId: "human-review",
      policyRevision: 1,
    }),
  )
  assert.equal(response.status, 200, response.body)
}

async function read(path: string): Promise<z.infer<typeof KnowledgeReadSchema>> {
  const response = await fixture.get(
    `/api/knowledge/v1/workspaces/workspace${path}`,
    fixture.reviewerToken,
  )
  assert.equal(response.status, 200, response.body)
  return KnowledgeReadSchema.parse(JSON.parse(response.body))
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

function externalRevisionSource(resourceId: string, value: string) {
  return {
    kind: "external",
    serviceInstanceId: "work-hub:local",
    resourceKind: "task",
    resourceId,
    version: { kind: "revision", value },
    permalink: `https://work-hub.example.test/tasks/${resourceId}`,
    role: "context",
  }
}

function externalDigestSource(resourceId: string, value: string) {
  return {
    kind: "external",
    serviceInstanceId: "work-hub:local",
    resourceKind: "result",
    resourceId,
    version: { kind: "digest", algorithm: "sha256", value },
    permalink: `https://work-hub.example.test/results/${resourceId}`,
    role: "supporting",
  }
}
