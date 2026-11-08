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
  R4_CONNECTOR_TOKEN: z.string().min(1).optional(),
  R4_REVIEWER_TOKEN: z.string().min(1).optional(),
})

const environment = EnvironmentSchema.parse(process.env)
const SnapshotResponseSchema = z.object({
  snapshot: z.object({ id: z.string().min(1) }).optional(),
})

type Role = "owner" | "viewer" | "connector" | "reviewer"

export type AppFixture = {
  readonly context: BrowserContext
  readonly page: Page
  readonly signIn: (role?: Role, path?: string) => Promise<SignedInIdentity>
  readonly expectEmptyBrowserStorage: () => Promise<void>
  readonly ownerCommand: (request: CommandRequest) => Promise<APIResponse>
  readonly ownerFeatureCommand: (request: FeatureCommandRequest) => Promise<APIResponse>
  readonly ownerExport: (payload: Readonly<Record<string, unknown>>) => Promise<APIResponse>
  readonly ownerRead: (path: string) => Promise<APIResponse>
  readonly featureCommand: (role: Role, request: FeatureCommandRequest) => Promise<APIResponse>
  readonly featureRead: (role: Role, path: string) => Promise<APIResponse>
}

type SignedInIdentity = {
  readonly workspaceId: string
  readonly principalId: string
  readonly spaceId: string
}

type CommandRequest = {
  readonly method: "post" | "patch"
  readonly path: string
  readonly baseRevision: number | null
  readonly payload: Readonly<Record<string, unknown>>
}

type FeatureCommandRequest = CommandRequest & { readonly feature: string }

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

    function tokenFor(role: Role): string {
      switch (role) {
        case "owner":
          return environment.R4_OWNER_TOKEN
        case "viewer":
          return environment.R4_VIEWER_TOKEN
        case "connector":
          if (environment.R4_CONNECTOR_TOKEN !== undefined) return environment.R4_CONNECTOR_TOKEN
          throw new TypeError("R4_CONNECTOR_TOKEN is required for connector browser flows")
        case "reviewer":
          if (environment.R4_REVIEWER_TOKEN !== undefined) return environment.R4_REVIEWER_TOKEN
          throw new TypeError("R4_REVIEWER_TOKEN is required for reviewer browser flows")
        default:
          return assertNever(role)
      }
    }

    async function signIn(role: Role = "owner", path = "/"): Promise<SignedInIdentity> {
      const token = tokenFor(role)
      activeToken = token
      await page.goto(path)
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible()
      const workspaceField = page.getByLabel("Workspace ID")
      if ((await workspaceField.inputValue()).length === 0)
        await workspaceField.fill(environment.R4_WORKSPACE_ID)
      else expect(await workspaceField.inputValue()).toBe(environment.R4_WORKSPACE_ID)
      await page.getByLabel("Bearer token").fill(token)
      const bootstrap = page.waitForResponse(
        (response) =>
          response.url().includes("/bootstrap") && response.request().method() === "GET",
      )
      await page.getByRole("button", { name: "Sign in" }).click()
      const response = await bootstrap
      expect(response.status()).toBe(200)
      const authenticated = BootstrapSchema.parse(await response.json())
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible()
      return {
        workspaceId: authenticated.workspace.id,
        principalId: authenticated.principal.id,
        spaceId: authenticated.currentSpaceId ?? authenticated.spaces[0]?.id ?? "",
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

    async function ownerFeatureCommand(request: FeatureCommandRequest): Promise<APIResponse> {
      return featureCommand("owner", request)
    }

    async function featureCommand(
      role: Role,
      request: FeatureCommandRequest,
    ): Promise<APIResponse> {
      const commandId = crypto.randomUUID()
      return context.request[request.method](
        `/api/${encodeURIComponent(request.feature)}/v1/workspaces/${encodeURIComponent(environment.R4_WORKSPACE_ID)}${request.path}`,
        {
          headers: { authorization: `Bearer ${tokenFor(role)}` },
          data: {
            commandId,
            idempotencyKey: `browser-${commandId}`,
            baseRevision: request.baseRevision,
            payload: request.payload,
          },
        },
      )
    }

    function featureRead(role: Role, path: string): Promise<APIResponse> {
      return context.request.get(path, {
        headers: { authorization: `Bearer ${tokenFor(role)}` },
      })
    }

    function ownerRead(path: string): Promise<APIResponse> {
      return context.request.get(
        `/api/human/v1/workspaces/${encodeURIComponent(environment.R4_WORKSPACE_ID)}${path}`,
        { headers: { authorization: `Bearer ${environment.R4_OWNER_TOKEN}` } },
      )
    }

    function ownerExport(payload: Readonly<Record<string, unknown>>): Promise<APIResponse> {
      return context.request.post(
        `/api/human/v1/workspaces/${encodeURIComponent(environment.R4_WORKSPACE_ID)}/export`,
        {
          headers: { authorization: `Bearer ${environment.R4_OWNER_TOKEN}` },
          data: payload,
        },
      )
    }

    await use({
      context,
      page,
      signIn,
      expectEmptyBrowserStorage,
      ownerCommand,
      ownerFeatureCommand,
      ownerExport,
      ownerRead,
      featureCommand,
      featureRead,
    })
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

function assertNever(value: never): never {
  throw new TypeError(`Unsupported browser role: ${JSON.stringify(value)}`)
}

export { expect }
