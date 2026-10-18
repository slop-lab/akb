import { expect, test } from "./fixtures.ts"

test("authenticated feature workspace uses real R5-R8 surfaces", async ({ app }) => {
  await app.signIn("owner")

  const planningReads: number[] = []
  app.page.on("response", (response) => {
    if (response.url().includes("/api/planning/v1/")) planningReads.push(response.status())
  })
  await app.page.getByRole("button", { name: "Planning" }).click()
  await expect(app.page.getByRole("heading", { name: "Cycles and outcomes" })).toBeVisible()
  await expect(app.page.getByRole("heading", { name: "Notifications" })).toBeVisible()
  await expect.poll(() => planningReads.length).toBeGreaterThan(0)
  expect(planningReads.every((status) => status === 200)).toBe(true)

  const pagesRead = app.page.waitForResponse(
    (response) =>
      response.url().includes("/api/content/v1/") && response.request().method() === "GET",
  )
  await app.page.getByRole("button", { name: "Pages" }).click()
  await expect(app.page.getByRole("heading", { name: "Pages", exact: true })).toBeVisible()
  expect((await pagesRead).status()).toBe(200)

  await app.page.getByRole("button", { name: "Runs" }).click()
  await expect(app.page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible()
  await expect(app.page.getByLabel("Installation ID")).toBeVisible()

  await app.page.getByRole("button", { name: "Knowledge" }).click()
  await expect(app.page.getByRole("heading", { name: "Proposals and review" })).toBeVisible()
  const knowledgeRead = app.page.waitForResponse(
    (response) =>
      response.url().includes("/api/knowledge/v1/") && response.request().method() === "GET",
  )
  await app.page.getByRole("main").getByRole("button", { name: "Search", exact: true }).click()
  expect((await knowledgeRead).status()).toBe(200)

  await app.page.getByRole("button", { name: "Automation" }).click()
  await expect(app.page.getByRole("heading", { name: "Intake and automation" })).toBeVisible()
  await expect(app.page.getByRole("heading", { name: "Analytics" })).toBeVisible()
  await expect(app.page.getByRole("heading", { name: "New intake" })).toBeVisible()
  await expect(app.page.getByRole("heading", { name: "Extension manifest" })).toBeVisible()

  const routes = [
    { label: "Planning", heading: "Cycles and outcomes" },
    { label: "Pages", heading: "Pages" },
    { label: "Runs", heading: "Runs" },
    { label: "Knowledge", heading: "Proposals and review" },
    { label: "Automation", heading: "Intake and automation" },
  ] as const
  for (const width of [375, 768, 1280] as const) {
    await app.page.setViewportSize({ width, height: 900 })
    for (const route of routes) {
      const navigation = app.page.locator("aside.sidebar nav")
      const menu = app.page.getByRole("button", { name: "Menu" })
      if (await menu.isVisible()) await menu.click()
      await navigation.getByRole("button", { name: route.label, exact: true }).click()
      await expect(
        app.page.getByRole("heading", { name: route.heading, exact: true }),
      ).toBeVisible()
      const overflow = await app.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBe(0)
    }
    if (width === 768) {
      const rail = app.page.locator(".sidebar")
      await expect(rail).toHaveCSS("width", "56px")
      await expect(rail.locator(".space-key--full").first()).toBeHidden()
      await expect(rail.locator(".space-key--rail").first()).toBeVisible()
    }
  }
  await app.expectEmptyBrowserStorage()
})

test("runtime collections append independently through their own cursors", async ({ app }) => {
  // Given: an authenticated operator and a run whose three collections each have two pages.
  await app.signIn("owner")
  const runId = "paged-browser-run"
  await app.page.route(new RegExp(`/runs/${runId}(?:/|\\?|$)`), async (route) => {
    const url = new URL(route.request().url())
    const isNextPage = url.searchParams.has("after")
    const createdAt = "2026-10-18T12:00:00.000Z"
    if (url.pathname.endsWith("/activity")) {
      const sequence = isNextPage ? 2 : 1
      await route.fulfill({
        json: {
          items: [
            {
              id: `00000000-0000-4000-8000-00000000000${sequence}`,
              generation: 1,
              sequence,
              kind: `activity-${sequence}`,
              actorId: "browser-actor",
              durable: true,
              body: {},
              references: [],
              createdAt,
            },
          ],
          nextAfter: isNextPage ? null : "1",
          hasMore: !isNextPage,
        },
      })
      return
    }
    if (url.pathname.endsWith("/receipts")) {
      const suffix = isNextPage ? "2" : "1"
      await route.fulfill({
        json: {
          items: [
            {
              id: `10000000-0000-4000-8000-00000000000${suffix}`,
              projection: "detail",
              createdAt,
              retentionUntil: createdAt,
            },
          ],
          nextAfter: isNextPage ? null : "receipt-1",
          hasMore: !isNextPage,
        },
      })
      return
    }
    if (url.pathname.endsWith("/artifacts")) {
      const suffix = isNextPage ? "2" : "1"
      await route.fulfill({
        json: {
          items: [
            {
              id: `artifact-${suffix}`,
              kind: `report-${suffix}`,
              mediaType: "text/plain",
              retentionClass: "run",
              digest: null,
              byteSize: 12,
              complete: true,
              createdAt,
            },
          ],
          nextAfter: isNextPage ? null : "artifact-1",
          hasMore: !isNextPage,
        },
      })
      return
    }
    await route.fulfill({
      json: {
        id: runId,
        workspace_id: "browser-workspace",
        installation_id: "browser-installation",
        subject_ref: "browser-subject",
        directive_ref: "browser-directive",
        state: "running",
        generation: 1,
        depth: 0,
        created_at: createdAt,
        updated_at: createdAt,
      },
    })
  })

  // When: each collection's load-more action is used once.
  await app.page.getByRole("button", { name: "Runs" }).click()
  await app.page.getByLabel("Run ID").fill(runId)
  await app.page.getByRole("button", { name: "Inspect" }).click()
  await app.page.getByRole("button", { name: "Load more activity" }).click()
  await app.page.getByRole("button", { name: "Load more receipts" }).click()
  await app.page.getByRole("button", { name: "Load more artifacts" }).click()

  // Then: all prior items remain, each second page appends, and no load-more control remains.
  await expect(app.page.getByText("activity-1", { exact: false })).toBeVisible()
  await expect(app.page.getByText("activity-2", { exact: false })).toBeVisible()
  await expect(app.page.getByText("10000000-0000-4000-8000-000000000001")).toBeVisible()
  await expect(app.page.getByText("10000000-0000-4000-8000-000000000002")).toBeVisible()
  await expect(app.page.getByText("report-1", { exact: false })).toBeVisible()
  await expect(app.page.getByText("report-2", { exact: false })).toBeVisible()
  await expect(app.page.getByRole("button", { name: /Load more/ })).toHaveCount(0)
})
