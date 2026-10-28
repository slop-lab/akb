import { proposalSourcesFromContext } from "../../apps/web/src/features/content/workflow-ui.ts"
import { ContextReadResponseSchema } from "../../src/contracts/content/workflow.ts"
import { expect, test } from "./fixtures.ts"
import {
  createTemplatePage,
  MutationSchema,
  ProposalMutationSchema,
} from "./operational-pages-support.ts"

test.setTimeout(120_000)

test("Pages templates and a saved exact Task context feed the human Knowledge inbox", async ({
  app,
}) => {
  // Given: accepted Knowledge exists for mixed Page and Knowledge discovery.
  const suffix = crypto.randomUUID().slice(0, 8)
  const {
    R4_WORKSPACE_ID: workspaceId = "",
    R4_BROWSER_BASE_URL: browserBaseUrl = "http://127.0.0.1:3000",
  } = process.env
  const workspacePath = `/workspaces/${encodeURIComponent(workspaceId)}`
  const browserOrigin = new URL(browserBaseUrl).origin
  await app.context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: browserOrigin,
  })
  const knowledgeId = `operational-knowledge-${suffix}`
  const sourceProposal = ProposalMutationSchema.parse(
    await (
      await app.ownerFeatureCommand({
        feature: "knowledge",
        method: "post",
        path: "/proposals",
        baseRevision: null,
        payload: {
          targetId: knowledgeId,
          action: "knowledge.create",
          baseRevision: null,
          candidate: {
            type: "claim",
            title: `Operational source ${suffix}`,
            statement: "An accepted source for the explicit task context.",
            status: "proposed",
            confidence: 0.9,
            validityScope: "browser acceptance",
          },
          sources: [],
          relations: [],
          profileId: null,
          profileRevision: null,
          inputRevision: null,
        },
      })
    ).json(),
  )
  expect(
    (
      await app.ownerFeatureCommand({
        feature: "knowledge",
        method: "post",
        path: `/proposals/${sourceProposal.result.proposalId}/reviews`,
        baseRevision: 1,
        payload: {
          decision: "accepted",
          rationale: "Browser fixture source",
          policyId: "human-review",
          policyRevision: 1,
        },
      })
    ).status(),
  ).toBe(200)

  // Given: an owner creates both operational templates as ordinary editable Pages.
  await app.signIn("owner", `${workspacePath}/pages`)
  const commonTitle = `Common guidance ${suffix}`
  const commonCreate = await createTemplatePage(app.page, commonTitle, "common-guidance")
  await expect(app.page.getByRole("heading", { name: "Purpose", exact: true })).toBeVisible()
  const commonPageId = commonCreate.result.id
  const revisedTitle = `${commonTitle} revised`
  await app.page.getByLabel("Title", { exact: true }).fill(revisedTitle)
  const commonSave = app.page.waitForResponse(
    (response) =>
      response.url().endsWith(`/pages/${encodeURIComponent(commonPageId)}`) &&
      response.request().method() === "PATCH",
  )
  await app.page.getByRole("button", { name: "Save", exact: true }).click()
  expect((await commonSave).status()).toBe(200)
  const featureTitle = `Feature brief ${suffix}`
  await createTemplatePage(app.page, featureTitle, "feature-brief")
  await expect(app.page.getByRole("textbox", { name: `Edit ${featureTitle}` })).toBeVisible()

  // When: the owner pins the old Page revision and the current Knowledge revision.
  await app.page.locator("details.task-context > summary").click()
  await expect(app.page.locator("details.task-context")).toHaveAttribute("open", "")
  await app.page.getByLabel("Title search").fill(revisedTitle)
  await app.page.getByRole("button", { name: "Search", exact: true }).click()
  const pageResult = app.page.locator(".context-result").filter({ hasText: revisedTitle })
  await expect(pageResult).toContainText(commonPageId)
  await pageResult.getByLabel("Revision").fill("0")
  await pageResult.getByRole("button", { name: /^Add / }).click()
  await expect(app.page.getByRole("alert")).toContainText("Revision must be a positive integer")
  await pageResult.getByLabel("Revision").fill("1")
  await pageResult.getByRole("button", { name: /^Add / }).click()
  await app.page.getByLabel("Source kind").selectOption("knowledge")
  await app.page.getByLabel("Title search").fill(`Operational source ${suffix}`)
  await app.page.getByRole("button", { name: "Search", exact: true }).click()
  const knowledgeResult = app.page
    .locator(".context-result")
    .filter({ hasText: `Operational source ${suffix}` })
  await expect(knowledgeResult).toContainText(knowledgeId)
  await knowledgeResult.getByRole("button", { name: /^Add / }).click()
  await app.page.getByRole("link", { name: "Knowledge", exact: true }).click()
  await expect(app.page.getByRole("heading", { name: "Canonical knowledge" })).toBeVisible()
  await app.page.getByRole("link", { name: "Pages", exact: true }).click()
  await expect(app.page.getByRole("heading", { name: "Pages", exact: true })).toBeVisible()
  await app.page.locator("details.task-context > summary").click()
  await expect(app.page.locator(".context-reference")).toHaveCount(2)
  const selectionTitle = `Task context ${suffix}`
  await app.page.getByLabel("Selection Page title").fill(selectionTitle)
  const selectionCreate = app.page.waitForResponse(
    (response) => response.url().endsWith("/pages") && response.request().method() === "POST",
  )
  await app.page.getByRole("button", { name: "Save as Page", exact: true }).click()
  const selection = MutationSchema.parse(await (await selectionCreate).json())
  const selectionPageId = selection.result.id

  // Then: a fresh login restores the manifest and loads exactly the pinned old revision.
  const selectionLink = `${workspacePath}/pages/${encodeURIComponent(selectionPageId)}?revision=${selection.revision}`
  await app.signIn("owner", selectionLink)
  await expect(
    app.page.getByText(`Historical revision ${selection.revision}`, { exact: true }),
  ).toBeVisible()
  await app.page.locator("details.task-context > summary").click()
  await expect(app.page.locator("details.task-context")).toHaveAttribute("open", "")
  await expect(
    app.page.locator(".context-reference").filter({ hasText: commonPageId }),
  ).toContainText("rev 1")
  await expect(
    app.page.locator(".context-reference").filter({ hasText: knowledgeId }),
  ).toContainText("rev 1")
  const firstSource = app.page.locator(".context-reference").first()
  const sourceHref = await firstSource.getByRole("link", { name: "Open" }).getAttribute("href")
  await firstSource.getByRole("button", { name: "Copy link" }).click()
  expect(await app.page.evaluate(() => navigator.clipboard.readText())).toBe(sourceHref)
  const agentRequest = app.page.getByLabel("Agent request JSON")
  const agentRequestJson = await agentRequest.inputValue()
  expect(agentRequestJson).not.toContain("authorization")
  expect(agentRequestJson).not.toContain("token")
  await app.page.getByRole("button", { name: "Copy JSON" }).click()
  expect(await app.page.evaluate(() => navigator.clipboard.readText())).toBe(agentRequestJson)
  const contextRead = app.page.waitForResponse(
    (response) => response.url().endsWith("/context") && response.request().method() === "POST",
  )
  await app.page.getByRole("button", { name: "Load read-only context" }).click()
  const contextResponse = await contextRead
  expect(contextResponse.status()).toBe(200)
  const loadedContext = ContextReadResponseSchema.parse(await contextResponse.json())
  await expect(app.page.getByText("2 exact revisions", { exact: false })).toBeVisible()
  await expect(app.page.locator(".context-inspection")).toContainText(commonTitle)
  await expect(app.page.locator(".context-inspection")).not.toContainText(revisedTitle)
  await expect(app.page.locator(".context-item-preview")).toHaveCount(2)
  await expect(
    app.page.locator(".context-item-preview").filter({ hasText: `Operational source ${suffix}` }),
  ).toHaveCount(1)
  const proposalSourcesField = app.page.getByLabel("Proposal sources JSON")
  const proposalSourcesJson = await proposalSourcesField.inputValue()
  expect(JSON.parse(proposalSourcesJson)).toEqual(proposalSourcesFromContext(loadedContext))
  await app.page.getByRole("button", { name: "Copy sources" }).click()
  expect(await app.page.evaluate(() => navigator.clipboard.readText())).toBe(proposalSourcesJson)
  for (const width of [375, 768, 1280] as const) {
    await app.page.setViewportSize({ width, height: 900 })
    await app.page.locator("details.task-context").scrollIntoViewIfNeeded()
    const overflow = await app.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
    await app.page.screenshot({
      path: `.omo/evidence/akb-work-hub/operational-pages-${width}.png`,
      animations: "disabled",
    })
    await agentRequest.scrollIntoViewIfNeeded()
    await app.page.screenshot({
      path: `.omo/evidence/akb-work-hub/operational-pages-agent-${width}.png`,
      animations: "disabled",
    })
    await proposalSourcesField.scrollIntoViewIfNeeded()
    await app.page.screenshot({
      path: `.omo/evidence/akb-work-hub/operational-pages-sources-${width}.png`,
      animations: "disabled",
    })
  }

  // When: an agent submits a result with the saved selection Page as exact provenance.
  const resultProposal = ProposalMutationSchema.parse(
    await (
      await app.featureCommand("connector", {
        feature: "knowledge",
        method: "post",
        path: "/proposals",
        baseRevision: null,
        payload: {
          targetId: `operational-result-${suffix}`,
          action: "knowledge.create",
          baseRevision: null,
          candidate: {
            type: "claim",
            title: `Operational result ${suffix}`,
            statement: "The selected exact context produced a proposed result.",
            status: "proposed",
            confidence: 0.9,
            validityScope: "browser acceptance",
          },
          sources: proposalSourcesFromContext(loadedContext),
          relations: [],
          profileId: null,
          profileRevision: null,
          inputRevision: selection.revision,
        },
      })
    ).json(),
  )

  // Then: the existing human inbox records the decision; acceptance is never automatic.
  await app.signIn(
    "reviewer",
    `${workspacePath}/proposals/${encodeURIComponent(resultProposal.result.proposalId)}`,
  )
  await expect(
    app.page.getByRole("heading", { name: `Operational result ${suffix}` }),
  ).toBeVisible()
  await expect(app.page.getByText(`${commonPageId} · rev 1`, { exact: true })).toBeVisible()
  await expect(app.page.getByText(`${knowledgeId} · rev 1`, { exact: true })).toBeVisible()
  await expect(app.page.getByText(`${selectionPageId} · rev 1`, { exact: true })).toBeVisible()
  for (const width of [375, 768, 1280] as const) {
    await app.page.setViewportSize({ width, height: 900 })
    expect(
      await app.page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0)
    await app.page.screenshot({
      path: `.omo/evidence/akb-work-hub/operational-proposal-review-${width}.png`,
      animations: "disabled",
    })
    await app.page.locator(".proposal-detail").scrollIntoViewIfNeeded()
    await app.page.screenshot({
      path: `.omo/evidence/akb-work-hub/operational-proposal-detail-${width}.png`,
      animations: "disabled",
    })
  }
  await app.page.getByLabel("Rationale").fill("Reviewed against the saved exact Task context.")
  const review = app.page.waitForResponse(
    (response) => response.url().endsWith("/reviews") && response.request().method() === "POST",
  )
  await app.page.getByRole("button", { name: "Record review" }).click()
  expect((await review).status()).toBe(200)
  const proposalLink = `${workspacePath}/proposals/${encodeURIComponent(resultProposal.result.proposalId)}`
  await app.signIn("reviewer", proposalLink)
  await expect(app.page.getByText("Decision recorded", { exact: true })).toBeVisible()
  await app.page.setViewportSize({ width: 1280, height: 900 })
  await app.page.screenshot({
    path: ".omo/evidence/akb-work-hub/operational-proposal-decided-1280.png",
    animations: "disabled",
  })
  await app.expectEmptyBrowserStorage()
})
