import type { Locator, Route } from "@playwright/test"
import { z } from "zod"
import { SpaceConfigSchema } from "../../src/contracts/r4/index.ts"
import type { AppFixture } from "./fixtures.ts"
import { expect, test } from "./fixtures.ts"

const FIXTURE_COUNT = 101
const EntityResultSchema = z.object({ result: z.object({ id: z.string().min(1) }) })
const ProjectQueryBodySchema = z.object({
  search: z.string().nullable(),
  page: z.object({ cursor: z.string().nullable() }),
})

type FixtureProject = { readonly id: string; readonly name: string }

async function createProjects(
  app: AppFixture,
  principalId: string,
  spaceId: string,
  prefix: string,
): Promise<readonly FixtureProject[]> {
  const names = [
    `${prefix} target sentinel`,
    `${prefix} stale candidate`,
    `${prefix} alternate choice`,
    ...Array.from({ length: FIXTURE_COUNT - 3 }, (_, index) => `${prefix} filler ${index + 1}`),
  ]
  const projects: FixtureProject[] = []
  for (const [index, name] of names.entries()) {
    const response = await app.ownerCommand({
      method: "post",
      path: "/projects",
      baseRevision: null,
      payload: {
        name,
        slug: `${prefix}-${index}`,
        summary: "Owned browser pagination fixture",
        ownerId: principalId,
        leadIds: [],
        participatingSpaceIds: [spaceId],
        state: "planned",
        health: "on_track",
        priority: "none",
        startDate: null,
        targetDate: null,
      },
    })
    expect(response.status()).toBe(201)
    projects.push({ id: EntityResultSchema.parse(await response.json()).result.id, name })
  }
  return projects
}

async function createWorkItem(
  app: AppFixture,
  principalId: string,
  spaceId: string,
  title: string,
): Promise<void> {
  const configResponse = await app.ownerRead(`/spaces/${encodeURIComponent(spaceId)}/config`)
  expect(configResponse.status()).toBe(200)
  const config = SpaceConfigSchema.parse(await configResponse.json())
  const state = config.workflow.states.find((candidate) => candidate.isDefault)
  if (state === undefined) throw new TypeError("Default workflow state is unavailable")
  const response = await app.ownerCommand({
    method: "post",
    path: "/work-items",
    baseRevision: null,
    payload: {
      spaceId,
      title,
      accountableOwnerId: principalId,
      description: "Owned browser pagination fixture",
      type: "task",
      workflowStateId: state.id,
      projectId: null,
      priority: "none",
      labelIds: [],
      startDate: null,
      dueDate: null,
    },
  })
  expect(response.status()).toBe(201)
}

async function submitProjectSearch(search: Locator, value: string): Promise<void> {
  await search.fill(value)
  await search.press("Enter")
}

async function projectOptions(
  select: Locator,
): Promise<readonly { readonly value: string; readonly label: string }[]> {
  return select.evaluate((element) => {
    if (!(element instanceof HTMLSelectElement))
      throw new TypeError("Project field is not a select")
    return [...element.options].map((option) => ({ value: option.value, label: option.text }))
  })
}

async function delayStaleSearch(route: Route, staleSearch: string): Promise<void> {
  const body = ProjectQueryBodySchema.parse(route.request().postDataJSON())
  if (body.search === staleSearch) await new Promise((resolve) => setTimeout(resolve, 350))
  await route.continue()
}

test("Project pagination is latest-wins and preserves later-page selections", async ({ app }) => {
  test.setTimeout(180_000)
  // Given: exactly 101 owned Projects, with the sentinel created before 100 newer records.
  const identity = await app.signIn()
  await app.page.setViewportSize({ width: 1280, height: 900 })
  expect(identity.spaceId.length).toBeGreaterThan(0)
  const prefix = `page-${crypto.randomUUID().slice(0, 8)}`
  const projects = await createProjects(app, identity.principalId, identity.spaceId, prefix)
  const workTitle = `${prefix} owned work item`
  await createWorkItem(app, identity.principalId, identity.spaceId, workTitle)
  expect(projects).toHaveLength(FIXTURE_COUNT)
  const sentinel = projects[0]
  const stale = projects[1]
  const alternate = projects[2]
  if (sentinel === undefined || stale === undefined || alternate === undefined)
    throw new TypeError("Project fixtures are incomplete")

  // When: Projects reloads and two continuation clicks are dispatched in one browser task.
  await app.page.getByRole("button", { name: "Work", exact: true }).click()
  await app.page.getByRole("button", { name: "Projects", exact: true }).click()
  await expect(app.page.getByRole("heading", { name: sentinel.name })).toHaveCount(0)
  let continuationRequests = 0
  app.page.on("request", (request) => {
    if (!request.url().endsWith("/projects/query")) return
    const body = ProjectQueryBodySchema.parse(request.postDataJSON())
    if (body.page.cursor !== null) continuationRequests += 1
  })
  await app.page.route("**/projects/query", async (route) => {
    const body = ProjectQueryBodySchema.parse(route.request().postDataJSON())
    if (body.page.cursor !== null) await new Promise((resolve) => setTimeout(resolve, 350))
    await route.continue()
  })
  const loadMore = app.page.getByRole("button", { name: "Load more projects" })
  await loadMore.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new TypeError("Load more is not a button")
    button.click()
    button.click()
  })
  await expect(loadMore).toHaveAttribute("aria-busy", "true")
  await expect(loadMore).toBeDisabled()
  await loadMore.scrollIntoViewIfNeeded()
  await app.page.screenshot({
    path: test.info().outputPath("project-pagination-loading-1280x900.png"),
  })

  // Then: one continuation appends the ordinal-101 sentinel exactly once.
  await expect(app.page.getByRole("heading", { name: sentinel.name })).toBeVisible()
  expect(continuationRequests).toBe(1)
  await expect(app.page.getByRole("heading", { name: sentinel.name })).toHaveCount(1)

  // When: Work's Project selector receives an intentionally reordered pair of real responses.
  await app.page.getByRole("button", { name: "Work", exact: true }).click()
  await app.page.getByText("More filters and sort").click()
  const filter = app.page.locator(".filter-panel")
  const projectSearch = filter.getByLabel("Search projects")
  await app.page.route("**/projects/query", (route) => delayStaleSearch(route, stale.name))
  const responseOrder: string[] = []
  app.page.on("response", (response) => {
    if (!response.url().endsWith("/projects/query")) return
    const body = ProjectQueryBodySchema.parse(response.request().postDataJSON())
    if (body.search === stale.name || body.search === sentinel.name) responseOrder.push(body.search)
  })
  const staleResponse = app.page.waitForResponse((response) => {
    if (!response.url().endsWith("/projects/query")) return false
    return ProjectQueryBodySchema.parse(response.request().postDataJSON()).search === stale.name
  })
  const latestResponse = app.page.waitForResponse((response) => {
    if (!response.url().endsWith("/projects/query")) return false
    return ProjectQueryBodySchema.parse(response.request().postDataJSON()).search === sentinel.name
  })
  await submitProjectSearch(projectSearch, stale.name)
  await submitProjectSearch(projectSearch, sentinel.name)
  expect((await latestResponse).status()).toBe(200)
  expect((await staleResponse).status()).toBe(200)

  // Then: the later search wins and the stale response never overwrites its options.
  expect(responseOrder).toEqual([sentinel.name, stale.name])
  const projectSelect = filter.locator('select[name="work-project"]')
  expect(await projectOptions(projectSelect)).toContainEqual({
    value: sentinel.id,
    label: sentinel.name,
  })
  await app.page.route(`**/projects/${sentinel.id}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350))
    await route.continue()
  })
  await projectSelect.selectOption(sentinel.id)
  await expect(projectSelect).toHaveValue(sentinel.id)

  // When: a replacement search and selection occur before the old selected lookup completes.
  await submitProjectSearch(projectSearch, alternate.name)
  await projectSelect.selectOption(alternate.id)

  // Then: the old selected lookup cannot reinsert the sentinel.
  await expect(projectSelect).toHaveValue(alternate.id)
  await expect
    .poll(() => projectOptions(projectSelect))
    .toContainEqual({
      value: alternate.id,
      label: alternate.name,
    })
  expect(await projectOptions(projectSelect)).not.toContainEqual({
    value: sentinel.id,
    label: sentinel.name,
  })

  // When: the owned Work item opens and its detail selector searches for the ordinal-101 Project.
  await app.page.getByRole("button", { name: new RegExp(workTitle) }).click()
  const detail = app.page.getByRole("complementary", { name: "Work item detail" })
  const detailSearch = detail.getByLabel("Search projects")
  await submitProjectSearch(detailSearch, sentinel.name)
  const detailProject = detail.locator('select[name="peek-project"]')
  const update = app.page.waitForResponse(
    (response) =>
      response.url().includes("/commands/v1/") && response.request().method() === "PATCH",
  )
  await detailProject.selectOption(sentinel.id)
  expect((await update).status()).toBe(200)

  // Then: the detail selector retains the later-page Project after the command reloads the item.
  await expect(detailProject).toHaveValue(sentinel.id)

  await app.page.screenshot({
    path: test.info().outputPath("project-pagination-1280x900.png"),
  })
})
