import { expect, test, type AppFixture } from "./fixtures.ts"

for (const mode of ["save", "restore", "conflict"] as const) {
  test(`a delayed ${mode} cannot replace a newly selected Page or attach its error`, async ({
    app,
  }) => {
    const suffix = crypto.randomUUID()
    const idA = `mutation-a-${suffix}`
    const idB = `mutation-b-${suffix}`
    const titleA = `Mutation A ${suffix}`
    const titleB = `Mutation B ${suffix}`
    await seed(app, idA, titleA)
    await seed(app, idB, titleB)
    if (mode === "restore") {
      expect(
        (
          await app.ownerFeatureCommand({
            feature: "content",
            method: "patch",
            path: `/pages/${idA}`,
            baseRevision: 1,
            payload: {
              document: {
                version: 1,
                blocks: [{ id: "body", type: "paragraph", text: "Second revision", children: [] }],
              },
            },
          })
        ).status(),
      ).toBe(200)
    }
    const { R4_WORKSPACE_ID: workspaceId = "" } = process.env
    await app.signIn("owner", `/workspaces/${workspaceId}/pages/${idA}`)
    await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(titleA)
    if (mode === "conflict") {
      expect(
        (
          await app.ownerFeatureCommand({
            feature: "content",
            method: "patch",
            path: `/pages/${idA}`,
            baseRevision: 1,
            payload: { title: `${titleA} server` },
          })
        ).status(),
      ).toBe(200)
    }
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const path = mode === "restore" ? `/pages/${idA}/restore` : `/pages/${idA}`
    await app.page.route(`**/api/content/v1/**${path}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.continue()
        return
      }
      const response = await route.fetch()
      expect(response.status()).toBe(mode === "conflict" ? 409 : 200)
      started?.()
      await held
      await route.fulfill({ response })
    })
    try {
      if (mode === "restore") {
        await app.page
          .locator(".record-row")
          .filter({ hasText: "rev 1" })
          .getByRole("button", { name: "Restore", exact: true })
          .click()
      } else {
        await app.page.getByLabel("Title", { exact: true }).fill(`${titleA} draft`)
        await app.page.getByRole("button", { name: "Save", exact: true }).click()
      }
      await ready
      await app.page.getByRole("button", { name: new RegExp(titleB) }).click()
      await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(titleB)
      release?.()
      await app.page.waitForLoadState("networkidle")
      await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(titleB)
      await expect(app.page.getByRole("alert")).toHaveCount(0)
    } finally {
      release?.()
    }
  })
}

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
