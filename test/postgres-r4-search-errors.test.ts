import assert from "node:assert/strict"
import type { Server } from "node:http"
import { after, test } from "node:test"
import { createSearchRoute } from "../src/http/human-v1/search-router.ts"
import { QueryBudgetExceededError } from "../src/human-query/service.ts"
import { createAuthenticatedPostgresServer } from "../src/postgres/authenticated-server.ts"
import { eventId, workItemId } from "../src/work-items/identifiers.ts"
import { createSearchFixture } from "./postgres-r4-search-fixture.ts"

const fixture = await createSearchFixture()
after(fixture.database.close)

test("HTTP search maps query budget exhaustion to the stable 507 envelope", async () => {
  // Given
  const server = createAuthenticatedPostgresServer(
    fixture.database.sql,
    {
      newWorkItemId: () => workItemId("legacy-budget-unused"),
      newEventId: () => eventId("legacy-budget-event-unused"),
      now: () => "2026-01-01T00:00:00.000Z",
    },
    [
      createSearchRoute({
        search: async () => {
          throw new QueryBudgetExceededError()
        },
      }),
    ],
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("HTTP address missing")

  // When
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/human/v1/workspaces/search/search`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "budget", kinds: ["work_item"], limit: 10 }),
    },
  )
  const body: unknown = await response.json()
  await close(server)

  // Then
  assert.equal(response.status, 507)
  assert.deepEqual(body, {
    error: {
      code: "query_budget_exceeded",
      message: "query_budget_exceeded",
      retryable: false,
      details: {},
    },
  })
})

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}
