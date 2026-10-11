import { expect, test } from "./fixtures.ts"

test("viewer isolation and in-memory authentication survive no persistence", async ({ app }) => {
  // Given: a fresh browser context authenticated as the restricted viewer.
  await app.signIn("viewer")

  // When: the viewer searches for the known private fixture marker.
  await app.page.getByRole("button", { name: "Search" }).first().click()
  await expect(app.page.getByRole("heading", { name: "Search", exact: true })).toBeVisible()
  await app.page.getByLabel("Search text").fill("PRIVATE-NOT-FOR-VIEWER")
  const searchResponse = app.page.waitForResponse(
    (response) => response.url().includes("/search") && response.request().method() === "POST",
  )
  await app.page.getByRole("button", { name: "Search" }).last().click()

  // Then: server-authoritative search returns no private result and no credential storage exists.
  expect((await searchResponse).status()).toBe(200)
  await expect(app.page.getByRole("heading", { name: "No matches" })).toBeVisible()
  await expect(app.page.getByText("PRIVATE-NOT-FOR-VIEWER")).toHaveCount(0)
  await app.expectEmptyBrowserStorage()

  // When: the user signs out and refreshes.
  await app.page.getByRole("button", { name: "Sign out" }).click()
  await app.page.reload()

  // Then: authentication is still cleared and storage remains empty.
  await expect(app.page.getByRole("heading", { name: "Sign in" })).toBeVisible()
  await app.expectEmptyBrowserStorage()
})

test("invalid credentials fail without echoing the entered token", async ({ app }) => {
  // Given: the unauthenticated login screen.
  const invalidToken = `invalid-${crypto.randomUUID()}`
  await app.page.goto("/")
  await app.page.getByLabel("Workspace ID").fill("r4-demo")
  await app.page.getByLabel("Bearer token").fill(invalidToken)

  // When: invalid credentials are submitted.
  const response = app.page.waitForResponse((candidate) => candidate.url().includes("/bootstrap"))
  await app.page.getByRole("button", { name: "Sign in" }).click()

  // Then: the server rejects them, the secret is cleared, and it is never rendered.
  expect((await response).status()).toBe(401)
  const alert = app.page.getByRole("alert")
  await expect(alert).toBeVisible()
  expect(await alert.evaluate((element) => element.parentElement === document.activeElement)).toBe(
    true,
  )
  await expect(app.page.getByLabel("Bearer token")).toHaveValue("")
  await expect(app.page.getByText(invalidToken, { exact: false })).toHaveCount(0)
  await app.expectEmptyBrowserStorage()
})
