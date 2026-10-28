import assert from "node:assert/strict"
import { z } from "zod"
import { createContextSelectionDocument } from "../src/contracts/content/index.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { WorkHubPostgresFixture } from "./knowledge-work-hub-postgres-fixture.ts"

const CommandResultSchema = z.object({ result: z.object({ proposalId: z.string() }) })

type CreatePageInput = {
  readonly id: string
  readonly title: string
  readonly document: Readonly<Record<string, unknown>>
  readonly spaceId?: string | null
}

export class ContentWorkflowPostgresFixture {
  readonly hub: WorkHubPostgresFixture
  readonly contentReaderToken: string
  readonly knowledgeReaderToken: string

  private constructor(
    hub: WorkHubPostgresFixture,
    contentReaderToken: string,
    knowledgeReaderToken: string,
  ) {
    this.hub = hub
    this.contentReaderToken = contentReaderToken
    this.knowledgeReaderToken = knowledgeReaderToken
  }

  static async create(): Promise<ContentWorkflowPostgresFixture> {
    const hub = await WorkHubPostgresFixture.create()
    await hub.admin.provisionPrincipal({
      workspaceId: "workspace",
      principalId: "content-reader",
      displayName: "Content reader",
      kind: "human",
      role: "member",
      permissions: ["content.read"],
    })
    const contentReaderToken = (
      await hub.admin.issueToken({
        workspaceId: "workspace",
        principalId: "content-reader",
        expiresAt: "2030-01-01T00:00:00.000Z",
      })
    ).token
    await hub.admin.provisionPrincipal({
      workspaceId: "workspace",
      principalId: "knowledge-reader",
      displayName: "Knowledge reader",
      kind: "human",
      role: "member",
      permissions: ["knowledge.read"],
    })
    const knowledgeReaderToken = (
      await hub.admin.issueToken({
        workspaceId: "workspace",
        principalId: "knowledge-reader",
        expiresAt: "2030-01-01T00:00:00.000Z",
      })
    ).token
    const fixture = new ContentWorkflowPostgresFixture(
      hub,
      contentReaderToken,
      knowledgeReaderToken,
    )
    await fixture.seed()
    return fixture
  }

  close(): Promise<void> {
    return this.hub.close()
  }

  get(path: string, token: string) {
    return this.hub.get(path, token)
  }

  context(token: string, body: Readonly<Record<string, unknown>>) {
    return this.hub.post(
      "/api/content/v1/workspaces/workspace/context",
      token,
      JSON.stringify(body),
    )
  }

  async createPage(input: CreatePageInput): Promise<void> {
    const response = await this.hub.contentCommand("/pages", "POST", null, {
      pageId: input.id,
      spaceId: input.spaceId ?? null,
      title: input.title,
      document: input.document,
    })
    assert.equal(response.status, 201, response.body)
  }

  async createKnowledge(id: string, title: string): Promise<void> {
    const proposed = await this.hub.post(
      "/api/knowledge/v1/workspaces/workspace/proposals",
      this.hub.connectorToken,
      this.hub.commandEnvelope(null, {
        targetId: id,
        action: "knowledge.create",
        baseRevision: null,
        candidate: {
          type: "claim",
          title,
          statement: title,
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
    const proposalId = CommandResultSchema.parse(JSON.parse(proposed.body)).result.proposalId
    const accepted = await this.hub.post(
      `/api/knowledge/v1/workspaces/workspace/proposals/${encodeURIComponent(proposalId)}/reviews`,
      this.hub.reviewerToken,
      this.hub.commandEnvelope(1, {
        decision: "accepted",
        rationale: "approved",
        policyId: "human-review",
        policyRevision: 1,
      }),
    )
    assert.equal(accepted.status, 200, accepted.body)
  }

  private async seed(): Promise<void> {
    const spaces = new SpaceAdmin(this.hub.database.sql)
    await spaces.create({
      workspaceId: "workspace",
      spaceId: "private-documents",
      spaceName: "Private documents",
      visibility: "private",
    })
    await spaces.setPermissions({
      workspaceId: "workspace",
      spaceId: "private-documents",
      principalId: "owner",
      permissions: ["content.read", "content.manage"],
    })
    await this.createPage({
      id: "a-hidden",
      title: "ACL target",
      document: document("hidden"),
      spaceId: "private-documents",
    })
    await this.createPage({
      id: "b-acl-visible",
      title: "ACL target",
      document: document("visible"),
    })
    await this.createPage({ id: "b-visible", title: "Visible", document: document("original") })
    await this.createPage({ id: "unicode-page", title: "Unicode", document: document("é雪") })
    await this.hub.contentCommand("/pages/b-visible", "PATCH", 1, {
      document: document("updated"),
    })
    await this.hub.contentCommand("/pages/b-visible/archive", "POST", 2, {})
    await this.createKnowledge("knowledge-visible", "Visible knowledge")
    await this.createPage({
      id: "selection-valid",
      title: "Selection",
      document: createContextSelectionDocument("workspace", [
        { kind: "page", id: "b-visible", revision: 1 },
        { kind: "knowledge", id: "knowledge-visible", revision: 1 },
      ]),
    })
    await this.createPage({
      id: "selection-wrong-workspace",
      title: "Wrong workspace selection",
      document: createContextSelectionDocument("other", [
        { kind: "page", id: "b-visible", revision: 1 },
      ]),
    })
    await this.createPage({
      id: "selection-malformed",
      title: "Malformed selection",
      document: document("not a manifest"),
    })
    await this.createPage({
      id: "selection-duplicate",
      title: "Duplicate selection",
      document: {
        version: 1,
        blocks: [
          {
            id: "akb-context-selection",
            type: "code",
            language: "json",
            text: JSON.stringify({
              format: "akb-context-selection.v1",
              workspaceId: "workspace",
              references: [
                { kind: "page", id: "b-visible", revision: 1 },
                { kind: "page", id: "b-visible", revision: 1 },
              ],
            }),
            children: [],
          },
        ],
      },
    })
  }
}

export function document(text: string) {
  return { version: 1, blocks: [{ id: "body", type: "paragraph", text, children: [] }] }
}
