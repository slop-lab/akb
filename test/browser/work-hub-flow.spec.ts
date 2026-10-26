import { z } from "zod"
import { expect, test } from "./fixtures.ts"

const MutationSchema = z.object({
  result: z.record(z.string(), z.unknown()),
  revision: z.number().int().positive(),
})
const ProposalMutationSchema = MutationSchema.extend({
  result: z.object({ proposalId: z.string().min(1) }).passthrough(),
})

test.setTimeout(120_000)

test("Work Hub context returns as a durable human-reviewed knowledge proposal", async ({ app }) => {
  // Given: an owner creates and saves a canonical Page through the real Blocks UI.
  const suffix = crypto.randomUUID().slice(0, 8)
  const pageTitle = `Work Hub context ${suffix}`
  const pageText = `Immutable task context ${suffix}`
  const targetId = `work-hub-result-${suffix}`
  const taskId = `task-${suffix}`
  const resultRevision = `result-${suffix}-v1`
  const workspacePath = `/workspaces/${encodeURIComponent(process.env["R4_WORKSPACE_ID"] ?? "")}`
  await app.signIn("owner", `${workspacePath}/pages`)
  await app.page.getByLabel("New page title").fill(pageTitle)
  const createResponsePromise = app.page.waitForResponse(
    (response) => response.url().endsWith("/pages") && response.request().method() === "POST",
  )
  await app.page.getByRole("button", { name: "Create page" }).click()
  const createResponse = await createResponsePromise
  expect(createResponse.status()).toBe(201)
  const created = MutationSchema.parse(await createResponse.json())
  const pageId = z.string().parse(created.result["id"])
  const editor = app.page.locator(`[contenteditable="true"][aria-label="Edit ${pageTitle}"]`)
  await editor.fill(pageText)
  const saveResponsePromise = app.page.waitForResponse(
    (response) =>
      response.url().endsWith(`/pages/${encodeURIComponent(pageId)}`) &&
      response.request().method() === "PATCH",
  )
  await app.page.getByRole("button", { name: "Save", exact: true }).click()
  const saveResponse = await saveResponsePromise
  expect(saveResponse.status()).toBe(200)
  const saved = MutationSchema.parse(await saveResponse.json())

  // When: the exact Page revision is reopened after a fresh login and read by the connector.
  const pageLink = `${workspacePath}/pages/${encodeURIComponent(pageId)}?revision=${saved.revision}`
  await app.signIn("owner", pageLink)
  await expect(app.page.getByText(`Historical revision ${saved.revision}`)).toBeVisible()
  await expect(app.page.getByText(pageText, { exact: true })).toBeVisible()
  const connectorContext = await app.featureRead(
    "connector",
    `/api/content/v1/workspaces/${encodeURIComponent(process.env["R4_WORKSPACE_ID"] ?? "")}/pages/${encodeURIComponent(pageId)}/revisions/${saved.revision}`,
  )
  expect(connectorContext.status()).toBe(200)

  // When: the connector submits a result proposal with exact Page and Work Hub provenance.
  const proposalResponse = await app.featureCommand("connector", {
    method: "post",
    feature: "knowledge",
    path: "/proposals",
    baseRevision: null,
    payload: {
      targetId,
      action: "knowledge.create",
      baseRevision: null,
      candidate: {
        type: "claim",
        title: `Work Hub result ${suffix}`,
        statement: `The task produced a reviewed result for ${pageTitle}.`,
        status: "proposed",
        confidence: 0.9,
        validityScope: "integration acceptance",
      },
      sources: [
        { kind: "entity", entityId: pageId, revision: saved.revision, role: "context" },
        {
          kind: "external",
          serviceInstanceId: "work-hub-local",
          resourceKind: "task-result",
          resourceId: taskId,
          version: { kind: "revision", value: resultRevision },
          permalink: `http://work-hub.local/tasks/${taskId}/results/${resultRevision}`,
          excerpt: `Result captured from exact Page revision ${saved.revision}.`,
          role: "supporting",
        },
      ],
      relations: [],
      profileId: null,
      profileRevision: null,
      inputRevision: saved.revision,
    },
  })
  expect(proposalResponse.status()).toBe(201)
  const proposal = ProposalMutationSchema.parse(await proposalResponse.json())
  const pendingKnowledge = await app.featureRead(
    "connector",
    `/api/knowledge/v1/workspaces/${encodeURIComponent(process.env["R4_WORKSPACE_ID"] ?? "")}/objects/${encodeURIComponent(targetId)}`,
  )
  expect(pendingKnowledge.status()).toBe(404)

  // When: another principal discovers the durable proposal after login and accepts it.
  const proposalLink = `${workspacePath}/proposals/${encodeURIComponent(proposal.result.proposalId)}`
  await app.signIn("reviewer", proposalLink)
  await expect(app.page.getByRole("heading", { name: `Work Hub result ${suffix}` })).toBeVisible()
  await app.page.getByText("All candidate fields", { exact: true }).click()
  await expect(app.page.getByText("validityScope", { exact: true })).toBeVisible()
  await expect(app.page.getByText("integration acceptance", { exact: true })).toBeVisible()
  await expect(app.page.getByRole("link", { name: new RegExp(resultRevision) })).toBeVisible()
  const reviewResponsePromise = app.page.waitForResponse(
    (response) => response.url().endsWith("/reviews") && response.request().method() === "POST",
  )
  await app.page.getByLabel("Rationale").fill("Verified against the pinned task context.")
  await app.page.getByRole("button", { name: "Record review" }).click()
  expect((await reviewResponsePromise).status()).toBe(200)

  // Then: the decided proposal is read-only and accepted Knowledge preserves both source revisions.
  await app.signIn("reviewer", proposalLink)
  await expect(app.page.getByText("Decision recorded", { exact: true })).toBeVisible()
  await expect(app.page.getByRole("button", { name: "Record review" })).toHaveCount(0)
  const knowledgeLink = `${workspacePath}/knowledge/${encodeURIComponent(targetId)}?revision=1`
  await app.signIn("reviewer", knowledgeLink)
  await expect(app.page.getByText("This is exact immutable revision 1.")).toBeVisible()
  await expect(
    app.page.getByText(`${pageId} · rev ${saved.revision}`, { exact: true }),
  ).toBeVisible()
  await expect(app.page.getByRole("link", { name: new RegExp(resultRevision) })).toBeVisible()

  // Then: every touched route is captured at the documented responsive breakpoints.
  const captures = [
    { path: pageLink, heading: "Pages", slug: "pages" },
    { path: proposalLink, heading: `Work Hub result ${suffix}`, slug: "proposals" },
    { path: knowledgeLink, heading: `Work Hub result ${suffix}`, slug: "knowledge" },
  ] as const
  for (const capture of captures) {
    await app.signIn("reviewer", capture.path)
    await expect(
      app.page.getByRole("heading", { name: capture.heading, exact: true }),
    ).toBeVisible()
    for (const width of [375, 768, 1280] as const) {
      await app.page.setViewportSize({ width, height: 900 })
      const contained = await app.page
        .locator(".proposal-detail, .knowledge-detail")
        .evaluateAll((panels) => panels.every((panel) => panel.scrollWidth <= panel.clientWidth))
      expect(contained).toBe(true)
      await app.page.screenshot({
        path: `.omo/evidence/akb-work-hub/${capture.slug}-${width}.png`,
        fullPage: true,
        animations: "disabled",
      })
    }
  }

  // Then: invalid revisions and missing details clear prior content instead of showing stale/latest data.
  await app.signIn(
    "reviewer",
    `${workspacePath}/knowledge/${encodeURIComponent(targetId)}?revision=latest`,
  )
  await expect(app.page.getByRole("alert")).toContainText("Revision must be a positive integer")
  await expect(app.page.getByRole("heading", { name: `Work Hub result ${suffix}` })).toHaveCount(0)
  await app.signIn("reviewer", `${workspacePath}/proposals/missing-${suffix}`)
  await expect(app.page.getByRole("alert")).toBeVisible()
  await expect(app.page.getByRole("heading", { name: `Work Hub result ${suffix}` })).toHaveCount(0)

  // Then: a workspace-qualified link cannot be silently remapped to the reviewer's real Workspace.
  await app.page.goto(
    `/workspaces/wrong-${suffix}/knowledge/${encodeURIComponent(targetId)}?revision=1`,
  )
  await expect(app.page.getByRole("heading", { name: "Sign in" })).toBeVisible()
  await expect(app.page.getByLabel("Workspace ID")).toHaveValue(`wrong-${suffix}`)
  await expect(app.page.getByLabel("Workspace ID")).toHaveAttribute("readonly", "")
  await app.expectEmptyBrowserStorage()
})

test("simulated knowledge service outage renders an explicit repairable error", async ({ app }) => {
  // Given: a reviewer on the real Knowledge screen and a deliberately aborted API route.
  const workspacePath = `/workspaces/${encodeURIComponent(process.env["R4_WORKSPACE_ID"] ?? "")}`
  await app.signIn("reviewer", `${workspacePath}/knowledge`)
  await app.page.route("**/api/knowledge/v1/**/objects?*", (route) =>
    route.abort("connectionfailed"),
  )

  // When: the reviewer explicitly searches while the simulated transport failure is active.
  await app.page.getByLabel("Search knowledge").fill("simulated outage evidence")
  await app.page.getByRole("main").getByRole("button", { name: "Search", exact: true }).click()

  // Then: the UI exposes the failure inline rather than presenting an empty successful result.
  const alert = app.page.getByRole("alert")
  await expect(alert).toBeVisible()
  await expect(alert).not.toHaveText("")
  await expect(app.page.getByRole("heading", { name: "No knowledge loaded" })).toBeVisible()
  await app.page.unroute("**/api/knowledge/v1/**/objects?*")
})
