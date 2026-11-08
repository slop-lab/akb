import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { test } from "node:test"
import { createProjectKbClient, type ProjectKbRequest } from "../packages/project-kb/src/client.ts"
import { documentFromTemplate, PROJECT_KB_TEMPLATES } from "../packages/project-kb/src/contracts.ts"
import {
  createHttpTransport,
  ProjectKbHttpError,
} from "../packages/project-kb/src/http-transport.ts"
import { createServerProjectKbClient } from "../packages/project-kb/src/server.ts"

const page = {
  id: "page-a",
  workspaceId: "workspace-a",
  spaceId: null,
  parentPageId: "notebook-a",
  title: "First cue",
  revision: 2,
  lifecycle: "active",
  document: documentFromTemplate("music-brief"),
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T01:00:00.000Z",
}

test("package mutations preserve command identity and fetch the committed revision rather than latest", async () => {
  const requests: ProjectKbRequest[] = []
  const client = createProjectKbClient({
    workspaceId: "workspace-a",
    transport: async (request) => {
      requests.push(request)
      return request.method === "GET" ? { page } : { result: { id: page.id }, revision: 2 }
    },
  })
  const identity = {
    commandId: "9d2139dd-c99d-4faf-8012-c302987d3fd9",
    idempotencyKey: "logical-save",
  }
  await client.savePage({ ...page, revision: 1 }, identity)
  assert.deepEqual(requests, [
    {
      method: "PATCH",
      path: "/api/content/v1/workspaces/workspace-a/pages/page-a",
      body: {
        ...identity,
        baseRevision: 1,
        payload: { title: page.title, document: page.document },
      },
    },
    { method: "GET", path: "/api/content/v1/workspaces/workspace-a/pages/page-a/revisions/2" },
  ])
})

test("the portable client rejects invalid boundary payloads before making a request", async () => {
  let calls = 0
  const client = createProjectKbClient({
    workspaceId: "workspace-a",
    transport: async () => {
      calls += 1
      return {}
    },
  })
  await assert.rejects(async () =>
    client.createPage({ parentPageId: "root", title: " ", templateId: "blank" }),
  )
  assert.equal(calls, 0)
  await assert.rejects(client.getNotebook("project-a"))
})

test("creative templates produce valid independent block trees", () => {
  for (const template of PROJECT_KB_TEMPLATES) {
    const first = documentFromTemplate(template.id)
    const second = documentFromTemplate(template.id)
    assert.notEqual(first, second)
    assert.equal(new Set(first.blocks.map((block) => block.id)).size, first.blocks.length)
    assert.equal(
      first.blocks.some((block) => block.type === "paragraph"),
      true,
    )
  }
})

test("server entrypoint executes against an HTTP surface with per-request tokens and sanitized errors", async () => {
  const seen: string[] = []
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization ?? "")
    response.setHeader("content-type", "application/json")
    if (request.url?.includes("/notebook"))
      response.end(JSON.stringify({ projectId: "project-a", notebook: page }))
    else {
      response.writeHead(409)
      response.end(
        JSON.stringify({ error: { code: "revision_conflict", message: "must-not-echo-secret" } }),
      )
    }
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (address === null || typeof address === "string")
    throw new TypeError("Missing test server address")
  const baseUrl = `http://127.0.0.1:${address.port}`
  let token = "first-token"
  try {
    const client = createServerProjectKbClient({
      workspaceId: "workspace-a",
      baseUrl,
      token: () => token,
    })
    assert.equal((await client.getNotebook("project-a")).notebook?.id, page.id)
    token = "second-token"
    const transport = createHttpTransport({ baseUrl, token: () => token })
    await assert.rejects(
      transport({ method: "GET", path: "/conflict" }),
      (error: unknown) =>
        error instanceof ProjectKbHttpError &&
        error.status === 409 &&
        error.code === "revision_conflict" &&
        !error.message.includes("secret"),
    )
    assert.deepEqual(seen, ["Bearer first-token", "Bearer second-token"])
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
