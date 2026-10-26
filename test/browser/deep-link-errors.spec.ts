import { EventEmitter, once } from "node:events"
import { expect, test } from "./fixtures.ts"

test("invalid login focuses its committed error panel even before the next frame", async ({
  app,
}) => {
  // Given: a fast frame callback that exposes focusing before React commits the error panel.
  await app.page.addInitScript(() => {
    window.requestAnimationFrame = (callback) => {
      callback(performance.now())
      return 1
    }
  })
  await app.page.goto("/")
  await app.page.getByLabel("Workspace ID").fill("invalid-workspace")
  await app.page.getByLabel("Bearer token").fill("invalid-login-focus-fixture")

  // When: the actual authentication server rejects the submitted credential.
  await app.page.getByRole("button", { name: "Sign in", exact: true }).click()

  // Then: focus reaches the mounted error panel, not a missing ref or a timer-dependent target.
  await expect(app.page.getByRole("alert").locator("..")).toBeFocused()
  await expect(app.page.getByLabel("Bearer token")).toHaveValue("")
})

test("a late successful inbox read cannot erase a missing proposal error", async ({ app }) => {
  // Given: a real pending proposal and an inbox response held behind the missing-detail response.
  const suffix = crypto.randomUUID()
  const title = `Error ordering fixture ${suffix}`
  const pending = await app.featureCommand("connector", {
    feature: "knowledge",
    method: "post",
    path: "/proposals",
    baseRevision: null,
    payload: {
      targetId: `error-order-${suffix}`,
      action: "knowledge.create",
      baseRevision: null,
      candidate: {
        type: "claim",
        title,
        statement: "A successful list read must not clear an independent detail failure.",
        status: "proposed",
        confidence: 0.9,
        validityScope: "browser regression",
      },
      sources: [],
      relations: [],
      profileId: null,
      profileRevision: null,
      inputRevision: null,
    },
  })
  expect(pending.status()).toBe(201)
  const inboxGate = new EventEmitter()
  const inboxReleased = once(inboxGate, "release")
  await app.page.route("**/api/knowledge/v1/**/proposals?*", async (route) => {
    await inboxReleased
    await route.continue()
  })
  const missingId = `missing-${suffix}`
  const missing = app.page.waitForResponse(
    (response) =>
      response.url().includes("/api/knowledge/") &&
      response.url().endsWith(`/proposals/${missingId}`),
  )

  // When: the detail fails first, then the real authorized inbox succeeds.
  await app.signIn(
    "reviewer",
    `/workspaces/${encodeURIComponent(process.env["R4_WORKSPACE_ID"] ?? "")}/proposals/${missingId}`,
  )
  expect((await missing).status()).toBe(404)
  inboxGate.emit("release")
  await expect(app.page.getByRole("button", { name: new RegExp(title) })).toBeVisible()

  // Then: the independent failure remains visible and no stale proposal detail is shown.
  await expect(app.page.getByRole("alert")).toBeVisible()
  await expect(app.page.locator(".proposal-detail")).toHaveCount(0)
})
