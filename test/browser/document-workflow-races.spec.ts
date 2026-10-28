import { expect, test } from "./fixtures.ts"

test("an obsolete context response cannot restore a removed source", async ({ app }) => {
  const suffix = crypto.randomUUID()
  const title = `Obsolete source ${suffix}`
  const created = await app.ownerFeatureCommand({
    feature: "content",
    method: "post",
    path: "/pages",
    baseRevision: null,
    payload: {
      pageId: `obsolete-${suffix}`,
      title,
      document: {
        version: 1,
        blocks: [{ id: "body", type: "paragraph", text: title, children: [] }],
      },
    },
  })
  expect(created.status()).toBe(201)
  const { R4_WORKSPACE_ID: workspaceId = "" } = process.env
  await app.signIn("owner", `/workspaces/${workspaceId}/pages`)
  await app.page.locator("details.task-context > summary").click()
  await app.page.getByLabel("Title search").fill(title)
  await app.page.getByRole("button", { name: "Search", exact: true }).click()
  await app.page
    .locator(".context-result")
    .filter({ hasText: title })
    .getByRole("button", { name: /^Add/ })
    .click()
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  await app.page.route("**/api/content/v1/**/context", async (route) => {
    const response = await route.fetch()
    started?.()
    await held
    await route.fulfill({ response })
  })
  try {
    await app.page.getByRole("button", { name: "Load read-only context", exact: true }).click()
    await ready
    await app.page
      .locator(".context-reference")
      .getByRole("button", { name: /^Remove/ })
      .click()
    const response = app.page.waitForResponse((value) => value.url().endsWith("/context"))
    release?.()
    await response
    await expect(
      app.page.getByRole("button", { name: "Load read-only context", exact: true }),
    ).toHaveAttribute("aria-busy", "false")
    await expect(app.page.locator(".context-inspection")).toHaveCount(0)
  } finally {
    release?.()
  }
})

test("Page creation cannot be dismissed while its command is committing", async ({ app }) => {
  const { R4_WORKSPACE_ID: workspaceId = "" } = process.env
  await app.signIn("owner", `/workspaces/${workspaceId}/pages`)
  await app.page.getByRole("button", { name: "New Page", exact: true }).click()
  const dialog = app.page.getByRole("dialog", { name: "Create Page", exact: true })
  await dialog.getByLabel("Page title").fill(`Pending Page ${crypto.randomUUID()}`)
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  await app.page.route("**/api/content/v1/**/pages", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue()
      return
    }
    const response = await route.fetch()
    started?.()
    await held
    await route.fulfill({ response })
  })
  try {
    await dialog.getByRole("button", { name: "Create Page", exact: true }).click()
    await ready
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeDisabled()
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled()
    await app.page.keyboard.press("Escape")
    await expect(dialog).toBeVisible()
    await app.page.keyboard.press("b")
    await expect(dialog).toBeVisible()
  } finally {
    release?.()
  }
})

test("changing the byte budget invalidates the displayed context before another read", async ({
  app,
}) => {
  const suffix = crypto.randomUUID()
  const title = `Budget source ${suffix}`
  const created = await app.ownerFeatureCommand({
    feature: "content",
    method: "post",
    path: "/pages",
    baseRevision: null,
    payload: {
      pageId: `budget-${suffix}`,
      title,
      document: {
        version: 1,
        blocks: [{ id: "body", type: "paragraph", text: title, children: [] }],
      },
    },
  })
  expect(created.status()).toBe(201)
  const { R4_WORKSPACE_ID: workspaceId = "" } = process.env
  await app.signIn("owner", `/workspaces/${workspaceId}/pages`)
  await app.page.locator("details.task-context > summary").click()
  await app.page.getByLabel("Title search").fill(title)
  await app.page.getByRole("button", { name: "Search", exact: true }).click()
  await app.page
    .locator(".context-result")
    .filter({ hasText: title })
    .getByRole("button", { name: /^Add/ })
    .click()
  await app.page.getByRole("button", { name: "Load read-only context", exact: true }).click()
  await expect(app.page.locator(".context-inspection")).toBeVisible()
  await app.page.getByLabel("Context byte limit").fill("1")
  await expect(app.page.locator(".context-inspection")).toHaveCount(0)
})
