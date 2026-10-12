import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import {
  ImportCommitSchema,
  ImportValidationSchema,
  ProjectPageSchema,
  ProjectQuerySchema,
} from "../../src/contracts/r4/index.ts"
import { expect, test } from "./fixtures.ts"
import { parseNdjson } from "./transfer-data.ts"
import {
  createTransferProject,
  createTransferProjectView,
  createTransferSpace,
} from "./transfer-fixtures.ts"

const ExportErrorSchema = z.object({
  error: z.object({ code: z.literal("nonportable_graph"), retryable: z.literal(false) }),
})

test("transfer exports an owned portable graph and imports exact Project bytes safely", async ({
  app,
}, testInfo) => {
  // Given: an isolated Space, Project, and Saved View owned by this run.
  const identity = await app.signIn()
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8)
  const spaceId = `transfer-${suffix}`
  const spaceName = `Transfer portable ${suffix}`
  const projectName = `Transfer project ${suffix}`
  await createTransferSpace(app, spaceId, `KEY${suffix.slice(0, 7).toUpperCase()}`, spaceName)
  const projectId = await createTransferProject(
    app,
    identity.principalId,
    spaceId,
    projectName,
    suffix,
  )
  await createTransferProjectView(app, spaceId, projectId, `Portable project ${suffix}`)
  await app.signIn()

  // Then: the maximum-length Space key remains complete without overflowing at every QA width.
  const spaceKey = `KEY${suffix.slice(0, 7).toUpperCase()}`
  const spaceButton = app.page.getByTitle(`${spaceKey} · ${spaceName}`)
  for (const width of [1280, 768, 375]) {
    await app.page.setViewportSize({ width, height: 900 })
    const geometry = await spaceButton.locator(".space-key--full").evaluate((element) => ({
      text: element.textContent,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    expect(geometry.text).toBe(spaceKey)
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth)
  }
  await app.page.setViewportSize({ width: 1280, height: 900 })
  await app.page.getByRole("button", { name: "Workspace data" }).click()
  await expect(app.page.getByRole("heading", { name: "Import and export" })).toBeVisible()
  const scope = app.page.getByLabel("Scope")
  await scope.selectOption({ label: `Space: ${spaceName}` })

  // When: the lifecycle graph is downloaded with archived records.
  await app.page.getByLabel("Include archived records").check()
  const exportResponse = app.page.waitForResponse(
    (response) => response.url().endsWith("/export") && response.request().method() === "POST",
  )
  const downloadPromise = app.page.waitForEvent("download")
  await app.page.getByRole("button", { name: "Export", exact: true }).click()
  const exported = await exportResponse
  expect(exported.status()).toBe(200)
  expect(exported.headers()["content-type"]).toContain("application/x-ndjson")
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.ndjson$/)
  const downloadPath = testInfo.outputPath("lifecycle-export.ndjson")
  const downloadedBytes = await exported.body()
  await saveEvidence(downloadPath, downloadedBytes)

  // Then: the scoped graph contains only portable references needed by the Project copy.
  const downloadedRecords = parseNdjson(downloadedBytes)
  const sourceProjects = downloadedRecords.filter(
    (record) => record.kind === "project" && record.name === projectName,
  )
  expect(sourceProjects).toHaveLength(1)
  const manifest = downloadedRecords.find((record) => record.kind === "manifest")
  const space = downloadedRecords.find(
    (record) => record.kind === "space" && record.externalId === spaceId,
  )
  const project = sourceProjects[0]
  if (manifest === undefined || space === undefined || project === undefined)
    throw new TypeError("portable Project import dependencies missing")
  const states = downloadedRecords.filter(
    (record) => record.kind === "workflow_state" && record.spaceId === spaceId,
  )
  const importBytes = Buffer.from(
    `${[manifest, space, ...states, project].map((record) => JSON.stringify(record)).join("\n")}\n`,
  )
  await saveEvidence(testInfo.outputPath("project-import.ndjson"), importBytes)

  // When: the exact exported Project bytes are validated, committed, and submitted again.
  const roundTripValidationResponse = app.page.waitForResponse((response) =>
    response.url().includes("/imports?mode=validate"),
  )
  await app.page.getByLabel("Choose file").setInputFiles({
    name: "lifecycle-export.ndjson",
    mimeType: "application/x-ndjson",
    buffer: importBytes,
  })
  const roundTripValidation = await roundTripValidationResponse
  expect(roundTripValidation.status()).toBe(200)
  ImportValidationSchema.parse(await roundTripValidation.json())
  const roundTripCommitResponse = app.page.waitForResponse((response) =>
    response.url().includes("/imports?mode=commit"),
  )
  await app.page.getByRole("button", { name: "Commit exact bytes" }).click()
  const roundTripCommit = await roundTripCommitResponse
  expect(roundTripCommit.status()).toBe(200)
  expect(ImportCommitSchema.parse(await roundTripCommit.json()).replayed).toBe(false)

  const replayValidationResponse = app.page.waitForResponse((response) =>
    response.url().includes("/imports?mode=validate"),
  )
  await app.page.getByLabel("Choose file").setInputFiles({
    name: "lifecycle-export.ndjson",
    mimeType: "application/x-ndjson",
    buffer: importBytes,
  })
  const replayValidation = await replayValidationResponse
  expect(replayValidation.status()).toBe(200)
  ImportValidationSchema.parse(await replayValidation.json())
  const replayCommitResponse = app.page.waitForResponse((response) =>
    response.url().includes("/imports?mode=commit"),
  )
  await app.page.getByRole("button", { name: "Commit exact bytes" }).click()
  const replayCommit = await replayCommitResponse
  expect(replayCommit.status()).toBe(200)
  expect(ImportCommitSchema.parse(await replayCommit.json()).replayed).toBe(true)
  await expect(app.page.getByRole("status")).toContainText("Identical import replayed safely")
  await app.page.screenshot({ path: testInfo.outputPath("transfer-positive.png"), fullPage: true })

  // Then: re-export preserves the source graph and adds one exact Project clone.
  const reexportResponse = app.page.waitForResponse(
    (response) => response.url().endsWith("/export") && response.request().method() === "POST",
  )
  const reexportDownloadPromise = app.page.waitForEvent("download")
  await app.page.getByRole("button", { name: "Export", exact: true }).click()
  const reexported = await reexportResponse
  expect(reexported.status()).toBe(200)
  expect((await reexportDownloadPromise).suggestedFilename()).toMatch(/\.ndjson$/)
  const reexportPath = testInfo.outputPath("lifecycle-reexport.ndjson")
  const reexportedBytes = await reexported.body()
  await saveEvidence(reexportPath, reexportedBytes)
  const reexportedRecords = parseNdjson(reexportedBytes)
  expect(
    reexportedRecords.filter((record) => record.kind === "project" && record.name === projectName),
  ).toHaveLength(2)

  // Then: the cloned archived Projects are visible on the include-archived UI query.
  const projectsResponse = app.page.waitForResponse((response) =>
    response.url().endsWith("/projects/query"),
  )
  await app.page.getByRole("button", { name: "Projects", exact: true }).click()
  expect((await projectsResponse).status()).toBe(200)
  const loadMore = app.page.getByRole("button", { name: "Load more projects" })
  while ((await loadMore.count()) > 0) {
    const previousCount = await app.page.locator("article").count()
    const continuation = app.page.waitForResponse(
      (response) =>
        response.url().endsWith("/projects/query") &&
        ProjectQuerySchema.parse(response.request().postDataJSON()).page.cursor !== null,
    )
    await loadMore.click()
    const response = await continuation
    expect(response.status()).toBe(200)
    const page = ProjectPageSchema.parse(await response.json())
    await expect(app.page.locator("article")).toHaveCount(previousCount + page.items.length)
  }
  const projectCards = app.page.locator("article").filter({ hasText: projectName })
  await expect(projectCards).toHaveCount(2)
  await app.page.getByRole("button", { name: "Workspace data" }).click()

  // When: malformed NDJSON bytes separately cross the import boundary.
  const validationResponse = app.page.waitForResponse((response) =>
    response.url().includes("/imports?mode=validate"),
  )
  await app.page.getByLabel("Choose file").setInputFiles({
    name: "synthetic-invalid.ndjson",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from('{"invalid":true}\n'),
  })

  // Then: validation still rejects malformed bytes with a human-safe dialog and no commit action.
  expect((await validationResponse).status()).toBe(400)
  await expect(app.page.getByRole("button", { name: "Commit exact bytes" })).toHaveCount(0)
  await expect(app.page.getByRole("alert")).toBeVisible()

  // Given: an owned Space whose external ID collides with the owned Project ID.
  await createTransferSpace(
    app,
    projectId,
    `COL${suffix.slice(0, 7).toUpperCase()}`,
    `Collision ${suffix}`,
  )
  const update = await app.ownerCommand({
    method: "patch",
    path: `/projects/${encodeURIComponent(projectId)}`,
    baseRevision: 1,
    payload: { participatingSpaceIds: [spaceId, projectId] },
  })
  expect(update.status()).toBe(200)

  // When: the Project graph is exported with both cross-kind copies of that external ID.
  const response = await app.ownerExport({ includeArchived: true, projectId })

  // Then: the boundary returns the stable typed portability error.
  expect(response.status()).toBe(400)
  ExportErrorSchema.parse(await response.json())
})

async function saveEvidence(targetPath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, bytes)
}
