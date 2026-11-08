import { MutationResponseSchema } from "@slop-lab/akb-project-kb/contracts"
import { expect, test, type AppFixture } from "./fixtures.ts"

test.setTimeout(120_000)

test("independent project libraries support composition and map documents, conflicts, and fresh-login links", async ({
  app,
}) => {
  const identity = await app.signIn("owner", "/library")
  const suffix = crypto.randomUUID().slice(0, 8)
  const spaceId = `library-space-${suffix}`
  const space = await app.ownerCommand({
    method: "post",
    path: "/spaces",
    baseRevision: null,
    payload: {
      id: spaceId,
      key: `KB${suffix.slice(0, 6).toUpperCase()}`,
      name: `Creative work ${suffix}`,
      visibility: "public",
      description: "Project library browser acceptance",
      icon: null,
      leadId: identity.principalId,
    },
  })
  expect(space.status(), JSON.stringify(await space.json())).toBe(201)
  const projectOwner = { principalId: identity.principalId, spaceId }
  const musicId = await createProject(app, projectOwner, `Music studio ${suffix}`)
  const mapId = await createProject(app, projectOwner, `Map workshop ${suffix}`)
  await app.page.getByLabel("Search projects", { exact: true }).fill(suffix)
  await app.page.getByRole("button", { name: "Search", exact: true }).click()
  await expect(
    app.page
      .getByRole("combobox", { name: "Project", exact: true })
      .locator(`option[value="${musicId}"]`),
  ).toHaveCount(1)
  await app.page.getByRole("combobox", { name: "Project", exact: true }).selectOption(musicId)
  await app.page.getByRole("button", { name: "Create library", exact: true }).click()
  await createDocument(app, `Opening cue ${suffix}`, "music-brief")
  await expect(app.page.getByRole("heading", { name: "Musical intent", exact: true })).toBeVisible()
  await expect(app.page.locator(".task-context")).toHaveCount(0)
  const musicPageId = new URL(app.page.url()).searchParams.get("pageId")
  if (musicPageId === null) throw new TypeError("Expected a document deep link")
  const editedTitle = `Opening cue ${suffix} revised`
  await app.page.getByLabel("Title", { exact: true }).fill(editedTitle)
  await app.page
    .getByRole("textbox", { name: `Edit Opening cue ${suffix}`, exact: true })
    .locator("p")
    .first()
    .click()
  await app.page.keyboard.insertText(
    "A restrained piano cue that gradually opens into warm strings.",
  )
  const saved = app.page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().endsWith(encodeURIComponent(musicPageId)),
  )
  await app.page.getByRole("button", { name: "Save document", exact: true }).click()
  expect((await saved).status()).toBe(200)
  await expect(
    app.page.getByRole("textbox", { name: `Edit ${editedTitle}`, exact: true }),
  ).toContainText("restrained piano cue")
  const musicLink = app.page.url()

  const changed = await app.ownerFeatureCommand({
    feature: "content",
    method: "patch",
    path: `/pages/${encodeURIComponent(musicPageId)}`,
    baseRevision: 2,
    payload: { title: `${editedTitle} server` },
  })
  expect(changed.status()).toBe(200)
  await app.page.getByLabel("Title", { exact: true }).fill(`${editedTitle} local draft`)
  await app.page.getByRole("button", { name: "Save document", exact: true }).click()
  await expect(app.page.getByRole("alert")).toBeVisible()
  await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(
    `${editedTitle} local draft`,
  )
  await app.page.getByRole("button", { name: "Reload latest", exact: true }).click()
  await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(`${editedTitle} server`)

  await app.page.getByRole("combobox", { name: "Project", exact: true }).selectOption(mapId)
  await app.page.getByRole("button", { name: "Create library", exact: true }).click()
  await expect(
    app.page.getByRole("navigation", { name: "Documents", exact: true }),
  ).not.toContainText(editedTitle)
  await createDocument(app, `Harbor map ${suffix}`, "map-brief")
  await expect(
    app.page.getByRole("heading", { name: "Player experience", exact: true }),
  ).toBeVisible()
  for (const width of [375, 768, 1280]) {
    await app.page.setViewportSize({ width, height: 900 })
    await app.page.getByLabel("Title", { exact: true }).scrollIntoViewIfNeeded()
    expect(
      await app.page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ),
    ).toBe(false)
  }
  await app.signIn("owner", musicLink)
  await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(`${editedTitle} server`)
  await expect(
    app.page.getByRole("textbox", { name: `Edit ${editedTitle} server`, exact: true }),
  ).toContainText("restrained piano cue")
  await app.expectEmptyBrowserStorage()
})

async function createDocument(app: AppFixture, title: string, templateId: string) {
  const form = app.page.locator(".kb-create-form")
  await form.getByLabel("Document title", { exact: true }).fill(title)
  await form.getByRole("combobox", { name: "Template", exact: true }).selectOption(templateId)
  await form.getByRole("button", { name: "Create document", exact: true }).click()
  await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(title)
}

async function createProject(
  app: AppFixture,
  identity: { readonly principalId: string; readonly spaceId: string },
  name: string,
): Promise<string> {
  const response = await app.ownerCommand({
    method: "post",
    path: "/projects",
    baseRevision: null,
    payload: {
      name,
      slug: `library-${crypto.randomUUID()}`,
      summary: "Creative project knowledge browser acceptance",
      ownerId: identity.principalId,
      leadIds: [],
      participatingSpaceIds: [identity.spaceId],
      state: "active",
      health: "on_track",
      priority: "none",
      startDate: null,
      targetDate: null,
    },
  })
  const body: unknown = await response.json()
  expect(response.status(), JSON.stringify(body)).toBe(201)
  return MutationResponseSchema.parse(body).result.id
}
