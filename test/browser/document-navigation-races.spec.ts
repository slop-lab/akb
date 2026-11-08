import { createContextSelectionDocument } from "../../src/contracts/content/workflow.ts"
import { expect, test, type AppFixture } from "./fixtures.ts"

test("a delayed discovery cannot replace results for the newly submitted title", async ({
  app,
}) => {
  const suffix = crypto.randomUUID()
  const first = `First query ${suffix}`
  const second = `Second query ${suffix}`
  await seed(app, `first-${suffix}`, first)
  await seed(app, `second-${suffix}`, second)
  const { R4_WORKSPACE_ID: workspaceId = "" } = process.env
  await app.signIn("owner", `/workspaces/${workspaceId}/pages`)
  await app.page.locator("details.task-context > summary").click()
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  await app.page.route("**/api/content/v1/**/documents?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("query") !== first) {
      await route.continue()
      return
    }
    const response = await route.fetch()
    started?.()
    await held
    await route.fulfill({ response })
  })
  try {
    await app.page.getByLabel("Title search").fill(first)
    await app.page.getByRole("button", { name: "Search", exact: true }).click()
    await ready
    await app.page.getByLabel("Title search").fill(second)
    await app.page.getByRole("button", { name: "Search", exact: true }).click()
    await expect(app.page.locator(".context-result")).toContainText(second)
    release?.()
    await app.page.waitForLoadState("networkidle")
    await expect(app.page.locator(".context-result")).toContainText(second)
    await expect(app.page.locator(".context-result")).not.toContainText(first)
  } finally {
    release?.()
  }
})

test("a delayed Page response cannot restore an older saved selection after navigation", async ({
  app,
}) => {
  const suffix = crypto.randomUUID()
  const { R4_WORKSPACE_ID: workspaceId = "" } = process.env
  const sourceA = `source-a-${suffix}`
  const sourceB = `source-b-${suffix}`
  const selectionA = `selection-a-${suffix}`
  const selectionB = `selection-b-${suffix}`
  const titleA = `Saved A ${suffix}`
  const titleB = `Saved B ${suffix}`
  await seed(app, sourceA, `Source A ${suffix}`)
  await seed(app, sourceB, `Source B ${suffix}`)
  for (const [id, title, source] of [
    [selectionA, titleA, sourceA],
    [selectionB, titleB, sourceB],
  ] as const) {
    const created = await app.ownerFeatureCommand({
      feature: "content",
      method: "post",
      path: "/pages",
      baseRevision: null,
      payload: {
        pageId: id,
        title,
        document: createContextSelectionDocument(workspaceId, [
          { kind: "page", id: source, revision: 1 },
        ]),
      },
    })
    expect(created.status()).toBe(201)
  }
  await app.signIn("owner", `/workspaces/${workspaceId}/pages`)
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  await app.page.route(`**/api/content/v1/**/pages/${selectionA}`, async (route) => {
    const response = await route.fetch()
    started?.()
    await held
    await route.fulfill({ response })
  })
  try {
    await app.page.getByRole("button", { name: new RegExp(titleA) }).click()
    await ready
    await app.page.getByRole("button", { name: new RegExp(titleB) }).click()
    await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(titleB)
    release?.()
    await app.page.waitForLoadState("networkidle")
    await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(titleB)
    await app.page.locator("details.task-context > summary").click()
    await expect(app.page.locator(".context-reference")).toContainText(sourceB)
    await expect(app.page.locator(".context-reference")).not.toContainText(sourceA)
  } finally {
    release?.()
  }
})

async function seed(app: AppFixture, id: string, title: string) {
  const response = await app.ownerFeatureCommand({
    feature: "content",
    method: "post",
    path: "/pages",
    baseRevision: null,
    payload: {
      pageId: id,
      title,
      document: {
        version: 1,
        blocks: [{ id: "body", type: "paragraph", text: title, children: [] }],
      },
    },
  })
  expect(response.status()).toBe(201)
}
