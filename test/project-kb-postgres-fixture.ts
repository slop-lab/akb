import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { z } from "zod"
import { createR4CommandRouter } from "../src/http/command-v1/router.ts"
import { createContentRoutes } from "../src/http/content/index.ts"
import { createProjectKbRoutes } from "../src/http/project-kb/index.ts"
import { IdentityAdmin } from "../src/identity/admin.ts"
import { SpaceAdmin } from "../src/identity/space-admin.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { migrateDatabase } from "../src/postgres/migrate.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import {
  createUnmigratedPostgresTestFixture,
  type UnmigratedPostgresTestFixture,
} from "./postgres/postgres-fixture.ts"

export const CommandResultSchema = z.object({
  replayed: z.boolean(),
  result: z.object({ id: z.string() }),
  revision: z.number().int().positive(),
})
export const NotebookResponseSchema = z.object({
  projectId: z.string(),
  notebook: z
    .object({
      id: z.string(),
      title: z.string(),
      parentPageId: z.string().nullable(),
      revision: z.number().int().positive(),
      document: z.object({ blocks: z.array(z.object({ id: z.string(), type: z.string() })) }),
    })
    .nullable(),
})

type HttpResult = { readonly status: number; readonly body: unknown }

export class ProjectKbPostgresFixture {
  readonly database: UnmigratedPostgresTestFixture
  readonly ownerToken: string
  readonly viewerToken: string
  readonly projectId: string
  readonly #server: Server
  readonly #origin: string

  private constructor(input: {
    readonly database: UnmigratedPostgresTestFixture
    readonly server: Server
    readonly origin: string
    readonly ownerToken: string
    readonly viewerToken: string
    readonly projectId: string
  }) {
    this.database = input.database
    this.#server = input.server
    this.#origin = input.origin
    this.ownerToken = input.ownerToken
    this.viewerToken = input.viewerToken
    this.projectId = input.projectId
  }

  static async create(): Promise<ProjectKbPostgresFixture> {
    const database = await createUnmigratedPostgresTestFixture()
    await migrateDatabase(database.sql)
    const identity = new IdentityAdmin(database.sql)
    const owner = await identity.bootstrapWorkspace({
      workspaceId: "workspace",
      workspaceName: "Workspace",
      principalId: "owner",
      principalName: "Owner",
      expiresAt: "2030-01-01T00:00:00.000Z",
    })
    await database.sql`insert into membership_permissions (workspace_id,principal_id,permission)
      values ('workspace','owner','content.read'),('workspace','owner','content.manage')`
    await new SpaceAdmin(database.sql).create({
      workspaceId: "workspace",
      spaceId: "studio",
      spaceName: "Studio",
      visibility: "public",
    })
    await identity.provisionPrincipal({
      workspaceId: "workspace",
      principalId: "viewer",
      displayName: "Viewer",
      kind: "human",
      role: "member",
      permissions: ["project.read", "content.read"],
    })
    const viewer = await identity.issueToken({
      workspaceId: "workspace",
      principalId: "viewer",
      expiresAt: "2030-01-01T00:00:00.000Z",
    })
    const server = createAuthenticatedPostgresServer(
      database.sql,
      {
        newWorkItemId: () => workItemId("unused"),
        newEventId: () => eventId("unused"),
        now: () => "2026-10-29T00:00:00.000Z",
      },
      [
        ...createProjectKbRoutes(database.sql),
        ...createContentRoutes(database.sql),
        createR4CommandRouter(database.sql),
      ],
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string")
      throw new TypeError("server did not listen")
    const origin = `http://127.0.0.1:${(address satisfies AddressInfo).port}`
    const fixture = new ProjectKbPostgresFixture({
      database,
      server,
      origin,
      ownerToken: owner.token,
      viewerToken: viewer.token,
      projectId: "pending",
    })
    const project = await fixture.command(
      "/api/commands/v1/workspaces/workspace/projects",
      null,
      {
        name: "Album",
        slug: "album",
        summary: "",
        ownerId: "owner",
        leadIds: ["owner"],
        participatingSpaceIds: ["studio"],
        state: "active",
        health: "on_track",
        priority: "high",
        startDate: null,
        targetDate: null,
      },
      "project-create",
    )
    assert.equal(project.status, 201, JSON.stringify(project.body))
    return new ProjectKbPostgresFixture({
      database,
      server,
      origin,
      ownerToken: owner.token,
      viewerToken: viewer.token,
      projectId: CommandResultSchema.parse(project.body).result.id,
    })
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error === undefined ? resolve() : reject(error))),
    )
    await this.database.close()
  }

  command(
    path: string,
    baseRevision: number | null,
    payload: unknown,
    key: string,
    method: "POST" | "PATCH" = "POST",
  ): Promise<HttpResult> {
    return this.request(
      path,
      this.ownerToken,
      method,
      this.commandEnvelope(baseRevision, payload, key),
    )
  }

  get(path: string, token: string): Promise<HttpResult> {
    return this.request(path, token, "GET")
  }

  async request(
    path: string,
    token: string,
    method: "GET" | "POST" | "PATCH",
    body?: string,
  ): Promise<HttpResult> {
    const response = await fetch(`${this.#origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body }),
    })
    return { status: response.status, body: await response.json() }
  }

  commandEnvelope(baseRevision: number | null, payload: unknown, key: string): string {
    return JSON.stringify({
      commandId: `command-${key}`,
      idempotencyKey: key,
      baseRevision,
      payload,
    })
  }

  notebookPath(): string {
    return `/api/project-kb/v1/workspaces/workspace/projects/${encodeURIComponent(this.projectId)}/notebook`
  }

  contentPagePath(pageId: string): string {
    return `/api/content/v1/workspaces/workspace/pages/${encodeURIComponent(pageId)}`
  }
}

export function required(value: string | undefined): string {
  if (value === undefined) throw new TypeError("required test value is missing")
  return value
}
