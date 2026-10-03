import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { InternalErrorSchema } from "../src/http/error-schemas.ts"
import { createServer } from "../src/server.ts"
import {
  actorId,
  humanPrincipalId,
  revision,
  workItemId,
  workItemTitle,
  workspaceId,
} from "../src/work-items/identifiers.ts"
import type { WorkItem } from "../src/work-items/model.ts"
import type { WorkItemStore } from "../src/work-items/store.ts"

const ListEnvelopeSchema = z.object({
  items: z.array(z.unknown()),
  completeness: z.object({ returned: z.number(), matched: z.number(), truncated: z.boolean() }),
  omitted: z.array(z.object({ category: z.string(), count: z.number(), reason: z.string() })),
  nextCursor: z.null(),
  estimatedTokens: z.number(),
})

function item(index: number): WorkItem {
  return {
    id: workItemId(`item-${index}`),
    workspaceId: workspaceId("workspace"),
    title: workItemTitle(`Item ${index}`),
    state: "unstarted",
    accountableOwnerId: humanPrincipalId("owner"),
    revision: revision(1),
    createdAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
  }
}

test("HTTP composition accepts an application-owned store implementation", async (context) => {
  // Given
  let listCalls = 0
  const store: WorkItemStore = {
    create: () => ({ kind: "capacity_exceeded", resource: "items", capacity: 0 }),
    patch: (command) => ({ kind: "not_found", id: command.id }),
    get: () => undefined,
    list: () => {
      listCalls += 1
      return { items: [], matched: 0 }
    },
  }
  const server = createServer(store)
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("missing TCP address")

  // When
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/workspaces/workspace/work-items`,
  )

  // Then
  assert.equal(response.status, 200)
  assert.equal(listCalls, 1)
})

test("workspace list reports the named 100-item R2 budget truthfully", async (context) => {
  // Given
  const items = Array.from({ length: 100 }, (_, index) => item(index))
  const store: WorkItemStore = {
    create: () => ({ kind: "capacity_exceeded", resource: "items", capacity: 0 }),
    patch: (command) => ({ kind: "not_found", id: command.id }),
    get: () => undefined,
    list: (_workspace, limit) => ({ items: items.slice(0, limit), matched: 101 }),
  }
  const server = createServer(store)
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("missing TCP address")

  // When
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/workspaces/workspace/work-items`,
  )
  const body = ListEnvelopeSchema.parse(await response.json())

  // Then
  assert.equal(response.status, 200)
  assert.equal(body.items.length, 100)
  assert.deepEqual(body.completeness, { returned: 100, matched: 101, truncated: true })
  assert.deepEqual(body.omitted, [{ category: "work_item", count: 1, reason: "budget" }])
  assert.equal(body.nextCursor, null)
  assert.equal("snapshotId" in body, false)
  assert.equal("receiptId" in body, false)
})

test("unexpected writable failures return the stable internal error", async (context) => {
  // Given
  const store: WorkItemStore = {
    create: () => {
      throw new Error("adapter failed")
    },
    patch: (command) => ({ kind: "not_found", id: command.id }),
    get: () => undefined,
    list: () => ({ items: [], matched: 0 }),
  }
  const server = createServer(store)
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("missing TCP address")

  // When
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/workspaces/workspace/work-items`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "key" },
      body: JSON.stringify({
        title: "Title",
        accountableOwnerId: "owner",
        actorId: actorId("actor"),
      }),
    },
  )

  // Then
  assert.equal(response.status, 500)
  const body = InternalErrorSchema.parse(await response.json())
  assert.equal(body.error.code, "internal")
  assert.deepEqual(body.error.details, {})
})
