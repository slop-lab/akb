import { z } from "zod"
import { expect, test } from "./fixtures.ts"

const SpaceConfigSchema = z.object({
  workflow: z.object({ states: z.array(z.object({ id: z.string() })).min(1) }),
})

test("owner completes R8 planning, page conflict, knowledge, and automation mutations", async ({
  app,
}) => {
  test.setTimeout(90_000)
  const identity = await app.signIn("owner")
  await app.page.setViewportSize({ width: 1280, height: 900 })
  const suffix = crypto.randomUUID().slice(0, 8)

  // Given: an authenticated owner with a writable Space.
  const configResponse = await app.ownerRead(
    `/spaces/${encodeURIComponent(identity.spaceId)}/config`,
  )
  expect(configResponse.status()).toBe(200)
  const workflowStateId = SpaceConfigSchema.parse(await configResponse.json()).workflow.states[0]
    ?.id
  if (workflowStateId === undefined) throw new TypeError("fixture workflow state is missing")

  // When: the owner creates a planning cycle through the UI.
  await app.page.getByRole("button", { name: "Planning" }).click()
  await app.page.getByLabel("Cycle name").fill(`Browser cycle ${suffix}`)
  await app.page.getByLabel("Start date").fill("2026-11-01")
  await app.page.getByLabel("End date").fill("2026-11-14")
  await app.page.getByLabel("Goal").fill("Exercise the mutable planning surface")
  await app.page.getByRole("button", { name: "Create cycle" }).click()
  // Then: the persisted cycle appears in the server-backed list.
  const createdCycle = app.page
    .locator(".record-row")
    .filter({ hasText: `Browser cycle ${suffix}` })
  await expect(createdCycle).toBeVisible()
  await createdCycle.screenshot({
    path: "/tmp/opencode/r8-ui-qa/planning-cycle-created-detail.png",
  })
  await app.page.screenshot({
    path: "/tmp/opencode/r8-ui-qa/planning-cycle-created.png",
  })

  // When: a page is created, edited, then made stale by a concurrent server mutation.
  await app.page.getByRole("button", { name: "Pages" }).click()
  const pageTitle = `Browser page ${suffix}`
  await app.page.getByLabel("New page title").fill(pageTitle)
  const createPageResponse = app.page.waitForResponse((response) =>
    response.url().endsWith("/pages"),
  )
  await app.page.getByRole("button", { name: "Create page" }).click()
  const pageMutation = z
    .object({ result: z.object({ id: z.string() }) })
    .parse(await (await createPageResponse).json())
  const editedTitle = `${pageTitle} edited`
  await app.page.getByLabel("Title", { exact: true }).fill(editedTitle)
  await app.page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(editedTitle)
  const concurrent = await app.ownerFeatureCommand({
    feature: "content",
    method: "patch",
    path: `/pages/${encodeURIComponent(pageMutation.result.id)}`,
    baseRevision: 2,
    payload: { title: `${pageTitle} server` },
  })
  expect(concurrent.status()).toBe(200)
  const localDraft = `${pageTitle} local draft`
  await app.page.getByLabel("Title", { exact: true }).fill(localDraft)
  await app.page.getByRole("button", { name: "Save", exact: true }).click()
  // Then: the revision conflict is explicit and retains the unsent draft.
  const conflictAlert = app.page.getByRole("alert")
  await expect(conflictAlert).toContainText("changed on the server")
  await expect(conflictAlert).toContainText("Current server revision: 3")
  await expect(conflictAlert).toContainText("Your unsent draft is retained")
  await expect(conflictAlert.getByRole("button", { name: "Cancel" })).toBeVisible()
  await expect(conflictAlert.getByRole("button", { name: "Reload latest" })).toBeVisible()
  await expect(app.page.getByLabel("Title", { exact: true })).toHaveValue(localDraft)
  await app.page.screenshot({
    path: "/tmp/opencode/r8-ui-qa/page-edit-conflict.png",
  })
  await app.page.getByRole("alert").scrollIntoViewIfNeeded()
  await app.page.screenshot({ path: "/tmp/opencode/r8-ui-qa/page-edit-conflict-detail.png" })
  await conflictAlert.screenshot({ path: "/tmp/opencode/r8-ui-qa/page-edit-conflict-alert.png" })

  // When: a claim proposal is created and accepted through the built-in policy.
  await app.page.getByRole("button", { name: "Knowledge" }).click()
  await app.page.getByLabel("Target ID").fill(`browser-claim-${suffix}`)
  await app.page.getByLabel("Title", { exact: true }).fill(`Browser claim ${suffix}`)
  await app.page.getByLabel("Statement").fill("The browser can complete knowledge review.")
  await app.page.getByRole("button", { name: "Create proposal" }).click()
  await expect(app.page.getByText(/rev 1/)).toBeVisible()
  await app.page.getByLabel("Rationale").fill("Verified in authenticated browser QA")
  await app.page.getByRole("button", { name: "Record review" }).click()
  // Then: the accepted canonical claim appears in search results.
  const acceptedClaim = app.page.locator("article").filter({ hasText: `Browser claim ${suffix}` })
  await expect(acceptedClaim.getByText("accepted", { exact: true })).toBeVisible()
  await acceptedClaim.screenshot({ path: "/tmp/opencode/r8-ui-qa/knowledge-accepted-detail.png" })
  await app.page.screenshot({
    path: "/tmp/opencode/r8-ui-qa/knowledge-accepted.png",
  })

  // When: analytics, intake acceptance, and an event rule execute through Automation.
  await app.page.getByRole("button", { name: "Automation" }).click()
  await app.page.getByLabel("From", { exact: true }).fill("2026-01-01T00:00")
  await app.page.getByLabel("To", { exact: true }).fill("2026-12-31T23:59")
  const analyticsResponse = app.page.waitForResponse(
    (response) =>
      response.url().includes("/automation/v1/") && response.url().includes("/analytics?"),
  )
  await app.page.getByRole("button", { name: "Query metric" }).click()
  expect((await analyticsResponse).status()).toBe(200)
  await expect(app.page.getByRole("heading", { name: "throughput" })).toBeVisible()

  const intake = app.page.locator("form").filter({ hasText: "New intake" })
  await intake.getByLabel("Target Space ID").fill(identity.spaceId)
  await intake.getByLabel("Title").fill(`Browser intake ${suffix}`)
  await intake.getByRole("button", { name: "Create intake" }).click()
  await app.page.getByText("Accept this intake").click()
  const acceptance = app.page.locator("form").filter({ hasText: "Accept into work" })
  await acceptance.getByLabel("Owner ID").fill(identity.principalId)
  await acceptance.getByLabel("Workflow state ID").fill(workflowStateId)
  await acceptance.getByRole("button", { name: "Accept into work" }).click()
  const intakeOutcome = app.page
    .locator("section.section-stack")
    .filter({ has: app.page.getByRole("heading", { name: "Create automation" }) })
    .getByRole("status")
  await expect(intakeOutcome).toHaveText("Intake accepted into work")
  await intakeOutcome.scrollIntoViewIfNeeded()
  await app.page.screenshot({ path: "/tmp/opencode/r8-ui-qa/automation-intake-accepted.png" })
  await intakeOutcome.screenshot({
    path: "/tmp/opencode/r8-ui-qa/automation-intake-accepted-detail.png",
  })

  const rule = app.page.locator("form").filter({ hasText: "Event rule" })
  await rule.getByLabel("Rule name").fill(`Browser rule ${suffix}`)
  await rule.getByLabel("Event type").fill("entity.updated")
  await rule.getByLabel("Target Space ID").fill(identity.spaceId)
  await rule.getByLabel("Intake title").fill(`Automated intake ${suffix}`)
  await rule.getByRole("button", { name: "Create rule" }).click()
  // Then: all three Automation requests report successful server outcomes.
  await expect(app.page.getByText("Automation rule created", { exact: true })).toBeVisible()
  await app.page.screenshot({
    path: "/tmp/opencode/r8-ui-qa/automation-mutations.png",
  })
})
