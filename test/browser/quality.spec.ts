import { expect, test } from "./fixtures.ts"

const BREAKPOINTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 900 },
  { name: "desktop", width: 1280, height: 900 },
] as const

test("implemented global shortcuts navigate and remain guarded in inputs", async ({ app }) => {
  // Given: an authenticated workspace.
  await app.signIn()

  // When: the search shortcut is pressed outside an editor.
  await app.page.keyboard.press("Control+k")

  // Then: Search opens and its labeled input receives focus.
  await expect(app.page.getByRole("heading", { name: "Search", exact: true })).toBeVisible()
  await expect(app.page.getByLabel("Search text")).toBeFocused()

  // When: the Work shortcut is typed while that input is focused.
  await app.page.getByLabel("Search text").fill("b")

  // Then: input guarding preserves the route and entered value.
  await expect(app.page.getByRole("heading", { name: "Search", exact: true })).toBeVisible()
  await expect(app.page.getByLabel("Search text")).toHaveValue("b")

  // When: focus leaves the editor and the Work shortcut is pressed.
  await app.page.getByRole("heading", { name: "Search", exact: true }).click()
  await app.page.keyboard.press("b")

  // Then: Work opens.
  await expect(app.page.getByRole("heading", { name: "Work" })).toBeVisible()
})

test("ten navigation cycles complete through released server snapshots", async ({ app }) => {
  // Given: an authenticated workspace with response accounting enabled.
  let projectQueries = 0
  let workQueries = 0
  app.page.on("response", (response) => {
    if (response.status() !== 200) return
    if (response.url().includes("/projects/query")) projectQueries += 1
    if (response.url().includes("/work-items/query")) workQueries += 1
  })
  await app.signIn()

  // When: the user performs ten complete Projects -> Work -> Projects cycles.
  for (let index = 0; index < 10; index += 1) {
    await app.page.getByRole("button", { name: "Work", exact: true }).click()
    await expect(app.page.getByRole("heading", { name: "Work" })).toBeVisible()
    await app.page.getByRole("button", { name: "Projects", exact: true }).click()
    await expect(app.page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible()
  }

  // Then: every cycle caused a successful query rather than exhausting snapshot ownership.
  expect(workQueries).toBe(10)
  expect(projectQueries).toBe(21)
  await expect(app.page.getByRole("alert")).toHaveCount(0)
})

test("responsive Work surfaces have no page overflow and produce safe evidence", async ({
  app,
}) => {
  // Given: an authenticated Work query narrowed to a synthetic, absent title.
  await app.signIn()
  await app.page.getByRole("button", { name: "Work", exact: true }).click()
  await expect(app.page.getByRole("heading", { name: "Work" })).toBeVisible()
  await app.page.getByRole("searchbox", { name: "Search" }).fill(`synthetic-${crypto.randomUUID()}`)
  const queryResponse = app.page.waitForResponse(
    (response) => response.url().includes("/work-items/query") && response.status() === 200,
  )
  await app.page.getByRole("button", { name: "Apply" }).click()
  await queryResponse
  await expect(
    app.page.getByRole("heading", { name: "No results for these filters" }),
  ).toBeVisible()

  for (const breakpoint of BREAKPOINTS) {
    // When: each documented viewport is rendered.
    await app.page.setViewportSize({ width: breakpoint.width, height: breakpoint.height })
    if (breakpoint.width >= 768) {
      await expect(app.page.getByRole("button", { name: "Work", exact: true })).toBeVisible()
      await expect(app.page.getByRole("button", { name: "Projects", exact: true })).toBeVisible()
    }

    // Then: the page remains within its viewport and evidence contains no user records.
    expect(
      await app.page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true)
    await app.page.screenshot({
      path: test.info().outputPath(`work-${breakpoint.name}.png`),
      fullPage: true,
    })
  }
})

test("Work detail tabs expose native semantics and keyboard navigation", async ({ app }) => {
  // Given: an authenticated Work list with a detail peek open.
  await app.signIn()
  await app.page.getByRole("button", { name: "Work", exact: true }).click()
  const workItems = app.page.getByRole("region", { name: "Work items" })
  await workItems.getByRole("button").first().click()
  const tablist = app.page.getByRole("tablist")
  const details = tablist.getByRole("tab", { name: "details" })
  const relations = tablist.getByRole("tab", { name: "relations" })
  const comments = tablist.getByRole("tab", { name: "comments" })

  // When: the documented Arrow, End, and Home keys are used.
  await details.focus()
  await details.press("ArrowRight")

  // Then: selection and focus move together across the complete tab set.
  await expect(relations).toHaveAttribute("aria-selected", "true")
  await expect(relations).toBeFocused()
  await relations.press("End")
  await expect(comments).toHaveAttribute("aria-selected", "true")
  await comments.press("Home")
  await expect(details).toHaveAttribute("aria-selected", "true")
  await expect(details).toBeFocused()

  const unlabeledFormControls = await app.page.evaluate(
    () =>
      [...document.querySelectorAll("input, select, textarea")].filter((element) => {
        if (
          !(element instanceof HTMLInputElement) &&
          !(element instanceof HTMLSelectElement) &&
          !(element instanceof HTMLTextAreaElement)
        )
          return false
        return element.labels?.length === 0 && element.getAttribute("aria-label") === null
      }).length,
  )
  expect(unlabeledFormControls).toBe(0)
})

test("authenticated startup stays responsive in real Chrome without console errors", async ({
  app,
}) => {
  // Given: a fresh real-Chrome context with error collection enabled.
  const consoleErrors: string[] = []
  app.page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })

  // When: authentication and the first Project query complete.
  const startedAt = Date.now()
  await app.signIn()
  const authenticatedMilliseconds = Date.now() - startedAt
  const browserMetrics = await app.page.evaluate(() => ({
    navigationMilliseconds: performance.getEntriesByType("navigation")[0]?.duration ?? 0,
    paintMilliseconds: Object.fromEntries(
      performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime]),
    ),
  }))
  await test.info().attach("real-chrome-performance.json", {
    body: Buffer.from(JSON.stringify({ authenticatedMilliseconds, ...browserMetrics }, null, 2)),
    contentType: "application/json",
  })

  // Then: the user-visible startup completes within a bounded budget and emits no console errors.
  expect(authenticatedMilliseconds).toBeLessThan(10_000)
  expect(browserMetrics.navigationMilliseconds).toBeLessThan(5_000)
  expect(consoleErrors).toEqual([])
})
