import { afterEach, expect, test, vi } from "vitest"
import { z } from "zod"
import { R4Api } from "./api.ts"

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, "", "/")
})

test("API reads stay origin-relative after opening a nested Page deep link", async () => {
  // Given: a nested route and a wire-level response, not an API-method mock.
  window.history.replaceState(null, "", "/pages/page%3A42?revision=2")
  const requests: string[] = []
  vi.stubGlobal("fetch", async (request: Request) => {
    requests.push(request.url)
    return new Response(JSON.stringify({ available: true }), {
      headers: { "content-type": "application/json" },
    })
  })
  const api = new R4Api("workspace", "test-only-token", () => {})

  // When: the feature client reads a Page while the browser is on that route.
  await api.feature(
    "api/content/v1/workspaces/workspace/pages/page%3A42/revisions/2",
    z.strictObject({ available: z.literal(true) }),
  )

  // Then: the request targets the owned API, never /pages/api or an HTML fallback.
  expect(requests).toEqual([
    `${window.location.origin}/api/content/v1/workspaces/workspace/pages/page%3A42/revisions/2`,
  ])
})
