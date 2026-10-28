import type { Server } from "node:http"
import { z } from "zod"
import { createContentRoutes } from "../src/http/content/index.ts"
import { createKnowledgeRoutes } from "../src/http/knowledge/index.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import type { PrincipalKind, WorkPermission } from "../src/identity/types.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres-fixture.ts"
import { sendRawRequest } from "./raw-http-fixture.ts"

const CommandEnvelopeSchema = z.strictObject({
  commandId: z.string(),
  idempotencyKey: z.string(),
  baseRevision: z.number().int().positive().nullable(),
  payload: z.unknown(),
})

export class WorkHubPostgresFixture {
  readonly database: UnmigratedPostgresTestFixture
  readonly admin: IdentityAdmin
  readonly ownerToken: string
  readonly connectorToken: string
  readonly reviewerToken: string
  readonly #server: Server
  readonly #port: number
  #sequence = 0

  private constructor(input: {
    readonly database: UnmigratedPostgresTestFixture
    readonly admin: IdentityAdmin
    readonly ownerToken: string
    readonly connectorToken: string
    readonly reviewerToken: string
    readonly server: Server
    readonly port: number
  }) {
    this.database = input.database
    this.admin = input.admin
    this.ownerToken = input.ownerToken
    this.connectorToken = input.connectorToken
    this.reviewerToken = input.reviewerToken
    this.#server = input.server
    this.#port = input.port
  }

  static async create(): Promise<WorkHubPostgresFixture> {
    const database = await createUnmigratedPostgresTestFixture()
    await migrateDatabase(database.sql)
    const admin = new IdentityAdmin(database.sql)
    const owner = await admin.bootstrapWorkspace({
      workspaceId: "workspace",
      workspaceName: "Workspace",
      principalId: "owner",
      principalName: "Owner",
      expiresAt: "2030-01-01T00:00:00.000Z",
    })
    await admin.setPermissions({
      workspaceId: "workspace",
      principalId: "owner",
      permissions: [
        "content.read",
        "content.manage",
        "knowledge.read",
        "knowledge.propose",
        "knowledge.accept",
        "review.read",
        "review.decide",
      ],
    })
    const connectorToken = await provision(admin, "work-hub", "service", [
      "content.read",
      "knowledge.read",
      "knowledge.propose",
    ])
    const reviewerToken = await provision(admin, "reviewer", "human", [
      "content.read",
      "knowledge.read",
      "knowledge.accept",
      "review.read",
      "review.decide",
    ])
    let sequence = 0
    const server = createAuthenticatedPostgresServer(
      database.sql,
      {
        newWorkItemId: () => workItemId(`unused-${++sequence}`),
        newEventId: () => eventId(`unused-${++sequence}`),
        now: () => "2026-10-26T00:00:00.000Z",
      },
      [...createContentRoutes(database.sql), ...createKnowledgeRoutes(database.sql)],
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new TypeError("server unavailable")
    return new WorkHubPostgresFixture({
      database,
      admin,
      ownerToken: owner.token,
      connectorToken,
      reviewerToken,
      server,
      port: address.port,
    })
  }

  get origin(): string {
    return `http://127.0.0.1:${this.#port}`
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
    await this.database.close()
  }

  contentCommand(
    path: string,
    method: "POST" | "PATCH",
    baseRevision: number | null,
    payload: Readonly<Record<string, unknown>>,
  ) {
    return this.post(
      `/api/content/v1/workspaces/workspace${path}`,
      this.ownerToken,
      this.commandEnvelope(baseRevision, payload),
      method,
    )
  }

  commandEnvelope(baseRevision: number | null, payload: unknown): string {
    const id = ++this.#sequence
    return JSON.stringify({
      commandId: `command-${id}`,
      idempotencyKey: `idempotency-${id}`,
      baseRevision,
      payload,
    })
  }

  replaceCommandPayload(envelope: string, payload: unknown): string {
    return JSON.stringify({ ...CommandEnvelopeSchema.parse(JSON.parse(envelope)), payload })
  }

  post(path: string, token: string, body: string, method: "POST" | "PATCH" = "POST") {
    return sendRawRequest({
      port: this.#port,
      method,
      path,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    })
  }

  get(path: string, token: string) {
    return sendRawRequest({
      port: this.#port,
      method: "GET",
      path,
      headers: { authorization: `Bearer ${token}` },
    })
  }
}

async function provision(
  admin: IdentityAdmin,
  principalId: string,
  kind: PrincipalKind,
  permissions: readonly WorkPermission[],
): Promise<string> {
  await admin.provisionPrincipal({
    workspaceId: "workspace",
    principalId,
    displayName: principalId,
    kind,
    role: "member",
    permissions: [...permissions],
  })
  return (
    await admin.issueToken({
      workspaceId: "workspace",
      principalId,
      expiresAt: "2030-01-01T00:00:00.000Z",
    })
  ).token
}
