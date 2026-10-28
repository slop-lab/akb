import type { Page } from "@playwright/test"
import { z } from "zod"
import { expect } from "./fixtures.ts"

export const MutationSchema = z.object({
  result: z.object({ id: z.string().min(1) }).passthrough(),
  revision: z.number().int().positive(),
})

export const ProposalMutationSchema = MutationSchema.extend({
  result: z.object({ proposalId: z.string().min(1) }).passthrough(),
})

export async function createTemplatePage(
  page: Page,
  title: string,
  template: "common-guidance" | "feature-brief",
): Promise<z.infer<typeof MutationSchema>> {
  await page.getByRole("button", { name: "New Page" }).click()
  await page.getByLabel("Page title", { exact: true }).fill(title)
  await page.getByLabel("Template").selectOption(template)
  const response = page.waitForResponse(
    (candidate) => candidate.url().endsWith("/pages") && candidate.request().method() === "POST",
  )
  await page.getByRole("button", { name: "Create Page", exact: true }).click()
  const created = await response
  expect(created.status()).toBe(201)
  return MutationSchema.parse(await created.json())
}
