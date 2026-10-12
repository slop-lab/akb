import type { Server } from "node:http"
import { BoardSchema, ProjectPageSchema, QueryPageSchema } from "../src/contracts/r4/index.ts"
import { SearchPageSchema } from "../src/contracts/r4/search.ts"
import { createR4HumanRouter } from "../src/http/human-v1/human-router.ts"
import { createR4SearchRouter } from "../src/http/human-v1/search-router.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createSearchFixture, type SearchFixture } from "./postgres-r4-search-fixture.ts"

export type Surface = "work" | "project" | "board" | "search"
export type Continuation = {
  readonly snapshotId: string
  readonly cursor: string
}

export type ContinuationFixture = {
  readonly fixture: SearchFixture
  readonly firstPages: () => Promise<Readonly<Record<Surface, Continuation>>>
  readonly firstPage: (surface: Surface) => Promise<Response>
  readonly continuePage: (surface: Surface, cursor: string) => Promise<Response>
  readonly emptyPage: (surface: Surface) => Promise<Response>
  readonly release: (snapshotId: string) => Promise<Response>
  readonly expire: (snapshotIds: readonly string[]) => Promise<void>
  readonly updateEntities: () => Promise<void>
  readonly close: () => Promise<void>
}

export async function createContinuationFixture(): Promise<ContinuationFixture> {
  const fixture = await createSearchFixture()
  await fixture.execute("space.create", null, null, null, {
    id: "public",
    key: "PUB",
    name: "Public",
    visibility: "public",
    description: "",
    icon: null,
    leadId: null,
  })
  const states = await fixture.database.sql<{ readonly id: string }[]>`
    select id from workflow_states where workspace_id='search' and space_id='public' and is_default`
  const stateId = states[0]?.id
  if (stateId === undefined) throw new TypeError("fixture default state missing")
  const workIds = await Promise.all([
    fixture.createWork("public", stateId, "Frozen Work Alpha", "alpha"),
    fixture.createWork("public", stateId, "Frozen Work Zulu", "zulu"),
  ])
  const projectIds = await Promise.all([
    createProject(fixture, "Frozen Project Alpha", "frozen-project-alpha"),
    createProject(fixture, "Frozen Project Zulu", "frozen-project-zulu"),
  ])
  const server = createAuthenticatedPostgresServer(
    fixture.database.sql,
    {
      newWorkItemId: () => workItemId("unused"),
      newEventId: () => eventId("unused"),
      now: () => "2026-10-12T00:00:00.000Z",
    },
    [
      createR4SearchRouter(fixture.database.sql, fixture.signingKey),
      createR4HumanRouter(fixture.database.sql, fixture.signingKey),
    ],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("HTTP address missing")
  const origin = `http://127.0.0.1:${address.port}`
  const request = (path: string, init: RequestInit) =>
    fetch(`${origin}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${fixture.ownerToken}`,
        "content-type": "application/json",
      },
    })
  const page = (surface: Surface, cursor: string | null, search: string) => {
    const path = `/api/human/v1/workspaces/search/${surfacePath(surface)}`
    return request(path, {
      method: "POST",
      body: JSON.stringify(requestBody({ surface, cursor, search, stateId })),
    })
  }
  return {
    fixture,
    firstPages: async () => {
      const [workResponse, projectResponse, boardResponse, searchResponse] = await Promise.all([
        page("work", null, "frozen"),
        page("project", null, "frozen"),
        page("board", null, "frozen"),
        page("search", null, "frozen"),
      ])
      const work = QueryPageSchema.parse(await workResponse.json())
      const project = ProjectPageSchema.parse(await projectResponse.json())
      const board = BoardSchema.parse(await boardResponse.json())
      const search = SearchPageSchema.parse(await searchResponse.json())
      const boardCursor = board.columns.find((column) => column.state.id === stateId)?.nextCursor
      return {
        work: continuation(work.snapshot.id, work.nextCursor),
        project: continuation(project.snapshot.id, project.nextCursor),
        board: continuation(board.snapshot.id, boardCursor),
        search: continuation(search.snapshot.id, search.nextCursor),
      }
    },
    continuePage: (surface, cursor) => page(surface, cursor, "frozen"),
    firstPage: (surface) => page(surface, null, "frozen"),
    emptyPage: (surface) => page(surface, null, "unmatched-token"),
    release: (snapshotId) =>
      request(`/api/human/v1/workspaces/search/query-snapshots/${snapshotId}`, {
        method: "DELETE",
      }),
    expire: async (snapshotIds) => {
      await fixture.database.sql`update human_query_snapshots
        set created_at=clock_timestamp()-interval '2 seconds',
          expires_at=clock_timestamp()-interval '1 second'
        where id in ${fixture.database.sql(snapshotIds)}`
    },
    updateEntities: async () => {
      await Promise.all(
        workIds.map((id, index) =>
          fixture.execute("work-item.update", null, id, 1, {
            title: `Changed Work ${index}`,
          }),
        ),
      )
      await Promise.all(
        projectIds.map((id, index) => updateProject(fixture, id, `Changed Project ${index}`)),
      )
    },
    close: async () => {
      await close(server)
      await fixture.database.close()
    },
  }
}

function requestBody(input: {
  readonly surface: Surface
  readonly cursor: string | null
  readonly search: string
  readonly stateId: string
}) {
  const base = {
    model: "r4",
    filter: null,
    search: input.search,
    sort: [{ field: "title", direction: "asc" }],
    includeArchived: false,
    page: { size: 1, cursor: input.cursor },
  } as const
  switch (input.surface) {
    case "work":
      return base
    case "project": {
      const { model: _, ...project } = base
      return project
    }
    case "board":
      return { ...base, workflowStateId: input.cursor === null ? null : input.stateId }
    case "search":
      return { text: input.search, kinds: ["work_item"], limit: 1, cursor: input.cursor }
    default:
      return assertNever(input.surface)
  }
}

function surfacePath(surface: Surface): string {
  switch (surface) {
    case "work":
      return "work-items/query"
    case "project":
      return "projects/query"
    case "board":
      return "work-items/board"
    case "search":
      return "search"
    default:
      return assertNever(surface)
  }
}

function continuation(snapshotId: string, cursor: string | null | undefined): Continuation {
  if (cursor === null || cursor === undefined) throw new TypeError("fixture continuation missing")
  return { snapshotId, cursor }
}

async function createProject(fixture: SearchFixture, name: string, slug: string): Promise<string> {
  const result = await fixture.commands.execute({
    workspaceId: "search",
    principal: fixture.owner,
    commandId: slug,
    idempotencyKey: slug,
    baseRevision: null,
    action: "project.create",
    route: "project.create",
    resourceId: null,
    parentId: null,
    payload: {
      name,
      slug,
      summary: "",
      ownerId: "owner",
      leadIds: [],
      participatingSpaceIds: ["public"],
      state: "active",
      health: "on_track",
      priority: "none",
      startDate: null,
      targetDate: null,
    },
  })
  const id = Reflect.get(result.result, "id")
  if (typeof id !== "string") throw new TypeError("project ID missing")
  return id
}

async function updateProject(fixture: SearchFixture, id: string, name: string): Promise<void> {
  await fixture.commands.execute({
    workspaceId: "search",
    principal: fixture.owner,
    commandId: `update-${id}`,
    idempotencyKey: `update-${id}`,
    baseRevision: 1,
    action: "project.update",
    route: "project.update",
    resourceId: id,
    parentId: null,
    payload: { name },
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected surface: ${value}`)
}
