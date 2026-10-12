import type { Locator, Page } from "@playwright/test"
import { z } from "zod"
import { ProjectPageSchema } from "../../src/contracts/r4/index.ts"
import { expect, test } from "./fixtures.ts"

const EntityResultSchema = z.object({ result: z.object({ id: z.string().min(1) }) })

async function activate(control: Locator): Promise<void> {
  await control.focus()
  await control.press("Enter")
}

async function typeWithKeyboard(page: Page, control: Locator, value: string): Promise<void> {
  await control.focus()
  await page.keyboard.press("Control+a")
  await page.keyboard.type(value)
}

async function chooseWithKeyboard(control: Locator, value: string): Promise<void> {
  const values = await control
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option instanceof HTMLOptionElement ? option.value : "")),
    )
  const index = values.indexOf(value)
  if (index < 0) throw new Error(`Option ${value} is unavailable`)
  await control.focus()
  await control.press("Home")
  for (let offset = 0; offset < index; offset += 1) await control.press("ArrowDown")
  await control.press("Enter")
}

test.setTimeout(120_000)

test("owner completes Project, Work, collaboration, view, board, and Work lifecycle flows", async ({
  app,
}) => {
  // Given: an owner and unique synthetic Project and Work names.
  const suffix = crypto.randomUUID().slice(0, 8)
  const projectName = `E2E Project ${suffix}`
  const projectSlug = `e2e-project-${suffix}`
  const firstTitle = `E2E primary ${suffix}`
  const editedTitle = `${firstTitle} edited`
  const secondTitle = `E2E parent ${suffix}`
  const comment = `E2E comment ${suffix}`
  const savedViewName = `E2E view ${suffix}`
  await app.signIn()

  // When: the Project is created through its dialog.
  await activate(app.page.getByRole("button", { name: "Create project" }))
  await typeWithKeyboard(app.page, app.page.getByLabel("Name"), projectName)
  await typeWithKeyboard(app.page, app.page.getByLabel("Slug"), projectSlug)
  await typeWithKeyboard(
    app.page,
    app.page.getByLabel("Summary"),
    "Synthetic browser lifecycle evidence",
  )
  const participatingSpaces = app.page.getByLabel("Participating Space IDs")
  if ((await participatingSpaces.inputValue()).length === 0)
    await typeWithKeyboard(app.page, participatingSpaces, "research")
  const createProjectResponse = app.page.waitForResponse(
    (response) => response.url().endsWith("/projects") && response.request().method() === "POST",
  )
  await activate(app.page.getByRole("button", { name: "Create project", exact: true }).last())

  // Then: the command succeeds and the Project is rendered.
  const createdProjectResponse = await createProjectResponse
  expect(createdProjectResponse.status()).toBe(201)
  const projectId = EntityResultSchema.parse(await createdProjectResponse.json()).result.id
  const projectCard = app.page.locator("article").filter({ hasText: projectName })
  await expect(projectCard.getByRole("heading", { name: projectName })).toBeVisible()

  // When: Project context opens Work and creates two items.
  const projectWorkQuery = app.page.waitForResponse((response) =>
    response.url().includes("/work-items/query"),
  )
  await activate(projectCard.getByRole("button", { name: "Open work" }))
  expect((await projectWorkQuery).status()).toBe(200)

  async function createWork(title: string): Promise<string> {
    await activate(app.page.getByRole("button", { name: "Create work" }))
    await typeWithKeyboard(app.page, app.page.getByLabel("Title", { exact: true }), title)
    const responsePromise = app.page.waitForResponse(
      (response) =>
        response.url().endsWith("/work-items") && response.request().method() === "POST",
    )
    await activate(app.page.getByRole("button", { name: "Create work", exact: true }).last())
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const body = EntityResultSchema.parse(await response.json())
    await expect(app.page.getByRole("heading", { name: title })).toBeVisible()
    await app.page.keyboard.press("Escape")
    return body.result.id
  }

  await createWork(firstTitle)
  const secondId = await createWork(secondTitle)

  // When: the primary item is edited and receives a comment, relation, and parent.
  await activate(app.page.getByRole("button", { name: firstTitle }))
  await typeWithKeyboard(app.page, app.page.getByLabel("Title", { exact: true }), editedTitle)
  await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(editedTitle)
  await app.page.getByLabel("Title", { exact: true }).press("Tab")
  await expect(app.page.getByRole("heading", { name: editedTitle })).toBeVisible()
  await app.page.getByRole("tab", { name: "details" }).press("End")
  await expect(app.page.getByRole("tab", { name: "comments" })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  await typeWithKeyboard(app.page, app.page.getByLabel("Comment", { exact: true }), comment)
  await activate(app.page.getByRole("button", { name: "Comment" }))
  await expect(
    app.page.getByRole("tabpanel", { name: "comments" }).getByRole("paragraph"),
  ).toHaveText(comment)

  await app.page.getByRole("tab", { name: "comments" }).press("ArrowLeft")
  await expect(app.page.getByRole("tab", { name: "relations" })).toHaveAttribute(
    "aria-selected",
    "true",
  )
  const relationsPanel = app.page.getByRole("tabpanel", { name: "relations" })
  await typeWithKeyboard(app.page, relationsPanel.getByLabel("Target entity ID"), secondId)
  await chooseWithKeyboard(
    relationsPanel.getByRole("combobox", { name: "Type", exact: true }),
    "blocks",
  )
  await activate(relationsPanel.getByRole("button", { name: "Add relation" }))
  await expect(relationsPanel.getByText(`${editedTitle} blocks ${secondTitle}`)).toBeVisible()

  await typeWithKeyboard(app.page, relationsPanel.getByLabel("Parent entity ID"), secondId)
  await relationsPanel.getByRole("button", { name: "Add parent" }).click()
  await expect(relationsPanel.getByText(secondTitle, { exact: true })).toBeVisible()
  await app.page.keyboard.press("Escape")

  const search = app.page.getByRole("searchbox", { name: "Search" })
  await typeWithKeyboard(app.page, search, editedTitle)
  await activate(app.page.getByRole("button", { name: "Apply" }))
  await expect(
    app.page.getByRole("region", { name: "Work items" }).getByText(editedTitle, { exact: true }),
  ).toBeVisible()
  await typeWithKeyboard(app.page, search, "")
  await activate(app.page.getByRole("button", { name: "Apply" }))

  // When: a Saved View is created from the applied query.
  app.page.once("dialog", (dialog) => dialog.accept(savedViewName))
  await activate(app.page.getByRole("button", { name: "Save view" }))
  await expect(app.page.getByRole("button", { name: savedViewName })).toBeVisible()

  // When: the item is moved through the keyboard-accessible board select.
  const boardResponse = app.page.waitForResponse((response) => response.url().includes("/board"))
  await activate(app.page.getByRole("button", { name: "Board" }))
  expect((await boardResponse).status()).toBe(200)
  const firstCard = app.page.locator("article").filter({
    has: app.page.getByRole("button", { name: editedTitle, exact: true }),
  })
  const moveSelect = firstCard.getByLabel("Move")
  const currentState = await moveSelect.inputValue()
  const stateValues = await moveSelect
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option instanceof HTMLOptionElement ? option.value : "")),
    )
  const nextState = stateValues.find((value) => value.length > 0 && value !== currentState)
  expect(nextState).toBeDefined()
  if (nextState === undefined) throw new Error("No alternate workflow state is configured")
  await chooseWithKeyboard(moveSelect, nextState)
  await expect(moveSelect).toHaveValue(nextState)

  // Then: Work archive/restore commands return their rendered lifecycle states.
  await activate(app.page.getByRole("button", { name: editedTitle, exact: true }))
  await activate(app.page.getByRole("button", { name: "Archive work item" }))
  await expect(app.page.getByRole("button", { name: "Restore work item" })).toBeVisible()
  await activate(app.page.getByRole("button", { name: "Restore work item" }))
  await expect(app.page.getByRole("button", { name: "Archive work item" })).toBeVisible()
  await activate(app.page.getByRole("button", { name: "Archive work item" }))
  await expect(app.page.getByRole("button", { name: "Restore work item" })).toBeVisible()
  await app.page.keyboard.press("Escape")

  const projectsResponse = app.page.waitForResponse((response) =>
    response.url().endsWith("/projects/query"),
  )
  await activate(app.page.getByRole("button", { name: "Projects", exact: true }))
  expect((await projectsResponse).status()).toBe(200)
  const restoredProjectCard = app.page.locator("article").filter({ hasText: projectName })
  await expect(restoredProjectCard.getByRole("heading", { name: projectName })).toBeVisible()

  // When: the Project is archived, queried with includeArchived, and restored through the UI.
  const archiveResponse = app.page.waitForResponse((response) =>
    /\/projects\/[^/]+\/archive$/.test(new URL(response.url()).pathname),
  )
  const archivedQueryResponse = app.page.waitForResponse((response) =>
    response.url().endsWith("/projects/query"),
  )
  await activate(restoredProjectCard.getByRole("button", { name: "Archive" }))
  const archivedCommand = await archiveResponse
  expect(archivedCommand.status()).toBe(200)
  expect(EntityResultSchema.parse(await archivedCommand.json()).result.id).toBe(projectId)
  const archivedQuery = await archivedQueryResponse
  expect(archivedQuery.status()).toBe(200)
  const archivedPage = ProjectPageSchema.parse(await archivedQuery.json())
  const archivedProject = archivedPage.items.find((project) => project.id === projectId)
  expect(archivedProject?.archivedAt).not.toBeNull()
  await expect(restoredProjectCard.getByText("Archived", { exact: true })).toBeVisible()

  const restoreResponse = app.page.waitForResponse((response) =>
    /\/projects\/[^/]+\/restore$/.test(new URL(response.url()).pathname),
  )
  const restoredQueryResponse = app.page.waitForResponse((response) =>
    response.url().endsWith("/projects/query"),
  )
  await activate(restoredProjectCard.getByRole("button", { name: "Restore" }))
  const restoredCommand = await restoreResponse
  expect(restoredCommand.status()).toBe(200)
  expect(EntityResultSchema.parse(await restoredCommand.json()).result.id).toBe(projectId)
  const restoredQuery = await restoredQueryResponse
  expect(restoredQuery.status()).toBe(200)
  const restoredPage = ProjectPageSchema.parse(await restoredQuery.json())
  const restoredProject = restoredPage.items.find((project) => project.id === projectId)
  expect(restoredProject?.archivedAt).toBeNull()
  await expect(restoredProjectCard.getByRole("button", { name: "Archive" })).toBeVisible()
})

test("revision conflict retains the local title draft", async ({ app }) => {
  // Given: a synthetic Work item open at revision one.
  const suffix = crypto.randomUUID().slice(0, 8)
  const title = `E2E conflict ${suffix}`
  const localDraft = `${title} local`
  await app.signIn()
  await app.page.getByRole("button", { name: "Work", exact: true }).click()
  await app.page.getByRole("button", { name: "Create work" }).click()
  await app.page.getByLabel("Title", { exact: true }).fill(title)
  const createResponsePromise = app.page.waitForResponse((response) =>
    response.url().endsWith("/work-items"),
  )
  await app.page.getByRole("button", { name: "Create work", exact: true }).last().click()
  const createResponse = await createResponsePromise
  const itemId = EntityResultSchema.parse(await createResponse.json()).result.id
  await expect(app.page.getByRole("heading", { name: title })).toBeVisible()

  // When: another actor advances the revision before the local title blur submits.
  const externalUpdate = await app.ownerCommand({
    method: "patch",
    path: `/work-items/${encodeURIComponent(itemId)}`,
    baseRevision: 1,
    payload: { priority: "urgent" },
  })
  expect(externalUpdate.status()).toBe(200)
  await app.page.getByLabel("Title", { exact: true }).fill(localDraft)
  await app.page.getByLabel("Title", { exact: true }).press("Tab")

  // Then: the conflict is explicit and the unsent local draft remains available.
  await expect(app.page.getByRole("alert")).toContainText("changed on the server")
  await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(localDraft)
})
