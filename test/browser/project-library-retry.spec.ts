import {
  NotebookResponseSchema,
  PageResponseSchema,
  PagesResponseSchema,
  MutationResponseSchema,
} from "@slop-lab/akb-project-kb/contracts"
import { CommandEnvelopeSchema } from "../../src/contracts/r4/command.ts"
import { expect, test, type AppFixture } from "./fixtures.ts"

test.setTimeout(90_000)

for (const mode of ["notebook", "create", "save"] as const) {
  test(`a committed ${mode} retries its original identity after a lost response`, async ({
    app,
  }) => {
    const { projectId, workspaceId, title } = await prepare(app)
    const root = `/api/content/v1/workspaces/${encodeURIComponent(workspaceId)}/pages`
    const notebookPath = `/api/project-kb/v1/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/notebook`
    if (mode !== "notebook") {
      await app.page.getByRole("button", { name: "Create library", exact: true }).click()
      await expect(
        app.page.getByRole("button", { name: "Create document", exact: true }),
      ).toBeEnabled()
    }
    const form = app.page.locator(".kb-create-form")
    if (mode === "save") {
      await form.getByLabel("Document title", { exact: true }).fill(title)
      await form.getByRole("button", { name: "Create document", exact: true }).click()
      await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(title)
      await app.page.getByLabel("Title", { exact: true }).fill(`${title} revised`)
    }
    const pageId = new URL(app.page.url()).searchParams.get("pageId")
    const path =
      mode === "notebook"
        ? notebookPath
        : mode === "create"
          ? root
          : `${root}/${encodeURIComponent(pageId ?? "")}`
    const commands: Array<ReturnType<typeof CommandEnvelopeSchema.parse>> = []
    await app.page.route(`**${path}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.continue()
        return
      }
      commands.push(CommandEnvelopeSchema.parse(route.request().postDataJSON()))
      const response = await route.fetch()
      expect(response.status()).toBe(commands.length === 1 && mode !== "save" ? 201 : 200)
      if (commands.length === 1) await route.abort("failed")
      else await route.fulfill({ response })
    })
    const action =
      mode === "notebook"
        ? app.page.getByRole("button", { name: "Create library", exact: true })
        : mode === "create"
          ? app.page.getByRole("button", { name: "Create document", exact: true })
          : app.page.getByRole("button", { name: "Save document", exact: true })
    if (mode === "create") await form.getByLabel("Document title", { exact: true }).fill(title)
    await action.click()
    await expect(app.page.getByRole("alert")).toBeVisible()
    await expect(action).toBeEnabled()
    await action.click()
    await expect(app.page.getByRole("alert")).toHaveCount(0)
    if (mode === "notebook") {
      await expect(
        app.page.getByRole("button", { name: "Create document", exact: true }),
      ).toBeEnabled()
    } else {
      await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(
        mode === "save" ? `${title} revised` : title,
      )
      await expect(
        app.page.getByRole("button", { name: "Save document", exact: true }),
      ).toBeEnabled()
    }
    expect(commands).toHaveLength(2)
    expect(commands[1]).toEqual(commands[0])
    const notebook = NotebookResponseSchema.parse(
      await (await app.featureRead("owner", notebookPath)).json(),
    ).notebook
    if (notebook === null) throw new TypeError("Expected committed notebook")
    const documents = PagesResponseSchema.parse(
      await (
        await app.featureRead("owner", `${root}?parentPageId=${encodeURIComponent(notebook.id)}`)
      ).json(),
    ).pages
    expect(documents).toHaveLength(mode === "notebook" ? 0 : 1)
    if (mode === "save" && pageId !== null) {
      const saved = PageResponseSchema.parse(
        await (await app.featureRead("owner", `${root}/${encodeURIComponent(pageId)}`)).json(),
      ).page
      expect(saved.revision).toBe(2)
    }
  })
}

async function prepare(app: AppFixture) {
  const identity = await app.signIn("owner", "/library")
  const suffix = crypto.randomUUID().slice(0, 8)
  const spaceId = `retry-space-${suffix}`
  const space = await app.ownerCommand({
    method: "post",
    path: "/spaces",
    baseRevision: null,
    payload: {
      id: spaceId,
      key: `RT${suffix.slice(0, 6).toUpperCase()}`,
      name: `Retry acceptance ${suffix}`,
      visibility: "public",
      description: "Retry boundary acceptance",
      icon: null,
      leadId: identity.principalId,
    },
  })
  expect(space.status()).toBe(201)
  const response = await app.ownerCommand({
    method: "post",
    path: "/projects",
    baseRevision: null,
    payload: {
      name: `Retry project ${suffix}`,
      slug: `retry-${crypto.randomUUID()}`,
      summary: "Commit-then-disconnect regression",
      ownerId: identity.principalId,
      leadIds: [],
      participatingSpaceIds: [spaceId],
      state: "active",
      health: "on_track",
      priority: "none",
      startDate: null,
      targetDate: null,
    },
  })
  expect(response.status()).toBe(201)
  const projectId = MutationResponseSchema.parse(await response.json()).result.id
  await app.page.getByLabel("Search projects", { exact: true }).fill(suffix)
  await app.page.getByRole("button", { name: "Search", exact: true }).click()
  await app.page.getByRole("combobox", { name: "Project", exact: true }).selectOption(projectId)
  await expect(app.page.getByRole("button", { name: "Create library", exact: true })).toBeEnabled()
  return { projectId, workspaceId: identity.workspaceId, title: `Creative retry ${suffix}` }
}
