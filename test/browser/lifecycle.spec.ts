import { z } from "zod"
import { ProjectPageSchema } from "../../src/contracts/r4/index.ts"
import { expect, test } from "./fixtures.ts"

const EntityResultSchema = z.object({ result: z.object({ id: z.string().min(1) }) })

test.setTimeout(120_000)

test("owner completes Project, Work, collaboration, view, board, and Work lifecycle flows", async ({
  app,
}) => {
  // Given: an owner and unique synthetic Project and Work names.
  const suffix = crypto.randomUUID().slice(0, 8)
  const projectName = `E2E Project ${suffix}`
  const projectSlug = `e2e-project-${suffix}`
  const firstTitle = `E2E primary ${suffix}`
  const secondTitle = `E2E parent ${suffix}`
  const comment = `E2E comment ${suffix}`
  const savedViewName = `E2E view ${suffix}`
  await app.signIn()

  // When: the Project is created through its dialog.
  await app.page.getByRole("button", { name: "Create project" }).click()
  await app.page.getByLabel("Name").fill(projectName)
  await app.page.getByLabel("Slug").fill(projectSlug)
  await app.page.getByLabel("Summary").fill("Synthetic browser lifecycle evidence")
  const participatingSpaces = app.page.getByLabel("Participating Space IDs")
  if ((await participatingSpaces.inputValue()).length === 0)
    await participatingSpaces.fill("research")
  const createProjectResponse = app.page.waitForResponse(
    (response) => response.url().endsWith("/projects") && response.request().method() === "POST",
  )
  await app.page.getByRole("button", { name: "Create project", exact: true }).last().click()

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
  await projectCard.getByRole("button", { name: "Open work" }).click()
  expect((await projectWorkQuery).status()).toBe(200)

  async function createWork(title: string): Promise<string> {
    await app.page.getByRole("button", { name: "Create work" }).click()
    await app.page.getByLabel("Title", { exact: true }).fill(title)
    const responsePromise = app.page.waitForResponse(
      (response) =>
        response.url().endsWith("/work-items") && response.request().method() === "POST",
    )
    await app.page.getByRole("button", { name: "Create work", exact: true }).last().click()
    const response = await responsePromise
    expect(response.status()).toBe(201)
    const body = EntityResultSchema.parse(await response.json())
    await expect(app.page.getByRole("heading", { name: title })).toBeVisible()
    await app.page.getByRole("button", { name: "Close" }).click()
    return body.result.id
  }

  await createWork(firstTitle)
  const secondId = await createWork(secondTitle)

  // When: the primary item is edited and receives a comment, relation, and parent.
  await app.page.getByRole("button", { name: firstTitle }).click()
  await app.page.getByRole("tab", { name: "comments" }).click()
  await app.page.getByLabel("Comment", { exact: true }).fill(comment)
  await app.page.getByRole("button", { name: "Comment" }).click()
  await expect(
    app.page.getByRole("tabpanel", { name: "comments" }).getByRole("paragraph"),
  ).toHaveText(comment)

  await app.page.getByRole("tab", { name: "relations" }).click()
  const relationsPanel = app.page.getByRole("tabpanel", { name: "relations" })
  await relationsPanel.getByLabel("Target entity ID").fill(secondId)
  await relationsPanel.getByRole("combobox", { name: "Type", exact: true }).selectOption("blocks")
  await relationsPanel.getByRole("button", { name: "Add relation" }).click()
  await expect(relationsPanel.getByText(`${firstTitle} blocks ${secondTitle}`)).toBeVisible()

  await relationsPanel.getByLabel("Parent entity ID").fill(secondId)
  await relationsPanel.getByRole("button", { name: "Add parent" }).click()
  await expect(relationsPanel.getByText(secondTitle, { exact: true })).toBeVisible()
  await app.page.getByRole("button", { name: "Close" }).click()

  // When: a Saved View is created from the applied query.
  app.page.once("dialog", (dialog) => dialog.accept(savedViewName))
  await app.page.getByRole("button", { name: "Save view" }).click()
  await expect(app.page.getByRole("button", { name: savedViewName })).toBeVisible()

  // When: the item is moved through the keyboard-accessible board select.
  const boardResponse = app.page.waitForResponse((response) => response.url().includes("/board"))
  await app.page.getByRole("button", { name: "Board" }).click()
  expect((await boardResponse).status()).toBe(200)
  const firstCard = app.page.locator("article").filter({
    has: app.page.getByRole("button", { name: firstTitle, exact: true }),
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
  await moveSelect.selectOption(nextState)
  await expect(moveSelect).toHaveValue(nextState)

  // Then: Work archive/restore commands return their rendered lifecycle states.
  await app.page.getByRole("button", { name: firstTitle, exact: true }).click()
  await app.page.getByRole("button", { name: "Archive work item" }).click()
  await expect(app.page.getByRole("button", { name: "Restore work item" })).toBeVisible()
  await app.page.getByRole("button", { name: "Restore work item" }).click()
  await expect(app.page.getByRole("button", { name: "Archive work item" })).toBeVisible()
  await app.page.getByRole("button", { name: "Archive work item" }).click()
  await expect(app.page.getByRole("button", { name: "Restore work item" })).toBeVisible()
  await app.page.getByRole("button", { name: "Close" }).click()

  const projectsResponse = app.page.waitForResponse((response) =>
    response.url().endsWith("/projects/query"),
  )
  await app.page.getByRole("button", { name: "Projects", exact: true }).click()
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
  await restoredProjectCard.getByRole("button", { name: "Archive" }).click()
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
  await restoredProjectCard.getByRole("button", { name: "Restore" }).click()
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
