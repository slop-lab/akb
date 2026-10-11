import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { ImportCommitSchema, ImportValidationSchema } from "../../src/contracts/r4/index.ts"
import { expect, test } from "./fixtures.ts"
import {
  expectLifecycleGraph,
  expectProjectCopies,
  lifecycleCopyCount,
  lifecycleNames,
  parseNdjson,
  projectCopyCount,
  projectImportBytes,
} from "./transfer-data.ts"

test("transfer exports lifecycle data and imports exact Project bytes safely", async ({
  app,
}, testInfo) => {
  // Given: an authenticated owner and the bounded Space containing complete lifecycle records.
  await app.signIn()
  await app.page.getByRole("button", { name: "Workspace data" }).click()
  await expect(app.page.getByRole("heading", { name: "Import and export" })).toBeVisible()
  const scope = app.page.getByLabel("Scope")
  const sourceOption = scope.locator("option").filter({ hasText: "Space: Transfer Space" }).first()
  const sourceLabel = await sourceOption.textContent()
  expect(sourceLabel).not.toBeNull()
  if (sourceLabel === null) throw new TypeError("lifecycle Space option missing")
  await scope.selectOption({ label: sourceLabel })

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

  // Then: all six lifecycle kinds, graph links, and exact UTC timestamps are present.
  const downloadedRecords = parseNdjson(downloadedBytes)
  const names = lifecycleNames(downloadedRecords)
  const sourceCopies = lifecycleCopyCount(downloadedRecords, names)
  const sourceProjectCopies = projectCopyCount(downloadedRecords, names)
  expect(sourceCopies).toBeGreaterThan(0)
  expectLifecycleGraph(downloadedRecords, names, sourceCopies)
  expectProjectCopies(downloadedRecords, names, sourceProjectCopies)
  const importBytes = projectImportBytes(downloadedRecords, names)
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

  // Then: re-export preserves the source graph and adds one exact archived Project clone.
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
  expectLifecycleGraph(reexportedRecords, names, sourceCopies)
  expectProjectCopies(reexportedRecords, names, sourceProjectCopies + 1)

  // Then: the cloned archived Projects are visible on the include-archived UI query.
  const projectsResponse = app.page.waitForResponse((response) =>
    response.url().endsWith("/projects/query"),
  )
  await app.page.getByRole("button", { name: "Projects", exact: true }).click()
  expect((await projectsResponse).status()).toBe(200)
  const projectCards = app.page.locator("article").filter({ hasText: names.project })
  await expect(projectCards).toHaveCount(sourceProjectCopies + 1)
  await expect(projectCards.getByText("Archived", { exact: true })).toHaveCount(
    sourceProjectCopies + 1,
  )
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
})

async function saveEvidence(targetPath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, bytes)
}
