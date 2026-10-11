import {
  type APIResponse,
  type Browser,
  type BrowserContext,
  test as base,
  chromium,
  expect,
  type Page,
} from "@playwright/test"
import { z } from "zod"
import { BootstrapSchema } from "../../src/contracts/r4/index.ts"

const EnvironmentSchema = z.object({
  R4_BROWSER_CDP_URL: z.string().url().optional(),
  R4_WORKSPACE_ID: z.string().min(1),
  R4_OWNER_TOKEN: z.string().min(1),
  R4_VIEWER_TOKEN: z.string().min(1),
})

const environment = EnvironmentSchema.parse(process.env)
const SnapshotResponseSchema = z.object({
  snapshot: z.object({ id: z.string().min(1) }).optional(),
})

type Role = "owner" | "viewer"

type AppFixture = {
  readonly context: BrowserContext
  readonly page: Page
  readonly signIn: (role?: Role) => Promise<SignedInIdentity>
  readonly expectEmptyBrowserStorage: () => Promise<void>
  readonly ownerCommand: (request: CommandRequest) => Promise<APIResponse>
}

type SignedInIdentity = {
  readonly workspaceId: string
  readonly principalId: string
}

type CommandRequest = {
  readonly method: "post" | "patch"
  readonly path: string
  readonly baseRevision: number | null
  readonly payload: Readonly<Record<string, unknown>>
}

type BrowserFixtures = {
  readonly app: AppFixture
}

export const test = base.extend<BrowserFixtures>({
  app: async ({ baseURL }, use) => {
    const connected = environment.R4_BROWSER_CDP_URL !== undefined
    const browser: Browser =
      environment.R4_BROWSER_CDP_URL === undefined
        ? await chromium.launch({ channel: "chrome" })
        : await chromium.connectOverCDP(environment.R4_BROWSER_CDP_URL)
    const context = await browser.newContext({ baseURL: baseURL ?? "http://127.0.0.1:3000" })
    const page = await context.newPage()
    const snapshotIds = new Set<string>()
    const snapshotReads: Promise<void>[] = []
    let activeToken: string | null = null
    page.on("response", (response) => {
      if (
        response.status() !== 200 ||
        !/\/(query|board|search)$/.test(new URL(response.url()).pathname)
      )
        return
      snapshotReads.push(
        response.json().then((body) => {
          const parsed = SnapshotResponseSchema.safeParse(body)
          if (parsed.success && parsed.data.snapshot !== undefined)
            snapshotIds.add(parsed.data.snapshot.id)
        }),
      )
    })

    async function signIn(role: Role = "owner"): Promise<SignedInIdentity> {
      const token = role === "owner" ? environment.R4_OWNER_TOKEN : environment.R4_VIEWER_TOKEN
      activeToken = token
      await page.goto("/")
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible()
      await page.getByLabel("Workspace ID").fill(environment.R4_WORKSPACE_ID)
      await page.getByLabel("Bearer token").fill(token)
      const bootstrap = page.waitForResponse(
        (response) =>
          response.url().includes("/bootstrap") && response.request().method() === "GET",
      )
      await page.getByRole("button", { name: "Sign in" }).click()
      const response = await bootstrap
      expect(response.status()).toBe(200)
      const authenticated = BootstrapSchema.parse(await response.json())
      await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible()
      return {
        workspaceId: authenticated.workspace.id,
        principalId: authenticated.principal.id,
      }
    }

    async function expectEmptyBrowserStorage(): Promise<void> {
      expect(await context.cookies()).toHaveLength(0)
      const storage = await page.evaluate(async () => ({
        local: localStorage.length,
        session: sessionStorage.length,
        indexedDatabases: (await indexedDB.databases()).length,
      }))
      expect(storage).toEqual({ local: 0, session: 0, indexedDatabases: 0 })
    }

    async function ownerCommand(request: CommandRequest): Promise<APIResponse> {
      const commandId = crypto.randomUUID()
      return context.request[request.method](
        `/api/commands/v1/workspaces/${encodeURIComponent(environment.R4_WORKSPACE_ID)}${request.path}`,
        {
          headers: { authorization: `Bearer ${environment.R4_OWNER_TOKEN}` },
          data: {
            commandId,
            idempotencyKey: `browser-${commandId}`,
            baseRevision: request.baseRevision,
            payload: request.payload,
          },
        },
      )
    }

    await use({ context, page, signIn, expectEmptyBrowserStorage, ownerCommand })
    await Promise.all(snapshotReads)
    if (activeToken !== null) {
      const releases = await Promise.all(
        [...snapshotIds].map((snapshotId) =>
          context.request.delete(
            `/api/human/v1/workspaces/${encodeURIComponent(environment.R4_WORKSPACE_ID)}/query-snapshots/${encodeURIComponent(snapshotId)}`,
            { headers: { authorization: `Bearer ${activeToken}` } },
          ),
        ),
      )
      for (const release of releases) expect(release.status()).toBe(204)
    }
    await context.close()
    if (!connected) await browser.close()
  },
})

export { expect }
