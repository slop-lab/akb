import ky, { HTTPError, type KyInstance } from "ky"
import { type ZodType, z } from "zod"
import {
  type BoardRequest,
  BoardSchema,
  BootstrapSchema,
  CommandResultSchema,
  CommentSchema,
  type ExportRequest,
  HistoryEntrySchema,
  type HumanWorkQuery,
  ImportCommitSchema,
  ImportValidationSchema,
  ProjectPageSchema,
  type ProjectQuery,
  ProjectSchema,
  QueryPageSchema,
  RelationSchema,
  SavedViewSchema,
  SpaceConfigSchema,
  SpaceSchema,
  WorkItemDetailSchema,
} from "../../../../src/contracts/r4/index.ts"
import { type SearchKind, SearchPageSchema } from "../../../../src/contracts/r4/search.ts"
import { safeMessage } from "./api-errors.ts"
import { createBrowserUuid } from "./browser-uuid.ts"

const ApiErrorSchema = z.strictObject({
  error: z.object({
    code: z.string(),
    message: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    fieldErrors: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
  }),
})
const SpacesResponseSchema = z.strictObject({ spaces: z.array(SpaceSchema).readonly() })
const SavedViewsResponseSchema = z.strictObject({ views: z.array(SavedViewSchema).readonly() })
const EntityIdResultSchema = CommandResultSchema.extend({
  result: z.object({ id: z.string() }).passthrough(),
})

export class ApiError extends Error {
  override readonly name = "ApiError"
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(message)
  }
}

type CommandOptions = {
  readonly method: "post" | "patch" | "put"
  readonly path: string
  readonly baseRevision: number | null
  readonly payload: Readonly<Record<string, unknown>>
}

export class R4Api {
  readonly #http: KyInstance
  readonly #workspace: string

  constructor(workspace: string, token: string, onUnauthorized: () => void) {
    this.#workspace = workspace
    this.#http = ky.create({
      headers: { authorization: `Bearer ${token}` },
      retry: 0,
      timeout: 15_000,
      hooks: {
        afterResponse: [
          ({ response }) => {
            if (response.status === 401) onUnauthorized()
          },
        ],
      },
    })
  }

  #human(path: string): string {
    return `api/human/v1/workspaces/${encodeURIComponent(this.#workspace)}${path}`
  }

  #commands(path: string): string {
    return `api/commands/v1/workspaces/${encodeURIComponent(this.#workspace)}${path}`
  }

  async #json<T>(request: Promise<Response>, schema: ZodType<T>): Promise<T> {
    try {
      return schema.parse(await (await request).json())
    } catch (error) {
      if (error instanceof HTTPError) {
        const parsed = ApiErrorSchema.safeParse(error.data)
        if (parsed.success) {
          throw new ApiError(
            error.response.status,
            parsed.data.error.code,
            safeMessage(parsed.data.error.code, error.response.status),
            parsed.data.error.details ?? {},
          )
        }
        throw new ApiError(
          error.response.status,
          "request_failed",
          safeMessage("request_failed", error.response.status),
          {},
        )
      }
      throw error
    }
  }

  bootstrap() {
    return this.#json(this.#http.get(this.#human("/bootstrap")), BootstrapSchema)
  }
  feature<T>(
    path: string,
    schema: ZodType<T>,
    options: {
      readonly method?: "GET" | "POST" | "PATCH" | "PUT"
      readonly body?: unknown
    } = {},
  ): Promise<T> {
    return this.#json(
      this.#http(path, {
        method: options.method ?? "GET",
        ...(options.body === undefined ? {} : { json: options.body }),
      }),
      schema,
    )
  }
  spaces() {
    return this.#json(this.#http.get(this.#human("/spaces")), SpacesResponseSchema)
  }
  spaceConfig(id: string) {
    return this.#json(
      this.#http.get(this.#human(`/spaces/${encodeURIComponent(id)}/config`)),
      SpaceConfigSchema,
    )
  }
  project(id: string) {
    return this.#json(
      this.#http.get(this.#human(`/projects/${encodeURIComponent(id)}`)),
      ProjectSchema,
    )
  }
  workItem(id: string) {
    return this.#json(
      this.#http.get(this.#human(`/work-items/${encodeURIComponent(id)}`)),
      WorkItemDetailSchema,
    )
  }
  comments(id: string) {
    return this.#json(
      this.#http.get(this.#human(`/entities/${encodeURIComponent(id)}/comments`)),
      z.array(CommentSchema).readonly(),
    )
  }
  relations(id: string) {
    return this.#json(
      this.#http.get(this.#human(`/entities/${encodeURIComponent(id)}/relations`)),
      z.array(RelationSchema).readonly(),
    )
  }
  history(id: string) {
    return this.#json(
      this.#http.get(this.#human(`/entities/${encodeURIComponent(id)}/history`)),
      z.array(HistoryEntrySchema).readonly(),
    )
  }
  savedViews() {
    return this.#json(this.#http.get(this.#human("/saved-views")), SavedViewsResponseSchema)
  }
  queryProjects(query: ProjectQuery) {
    return this.#json(
      this.#http.post(this.#human("/projects/query"), { json: query }),
      ProjectPageSchema,
    )
  }
  queryWork(query: HumanWorkQuery) {
    return this.#json(
      this.#http.post(this.#human("/work-items/query"), { json: query }),
      QueryPageSchema,
    )
  }
  board(query: BoardRequest) {
    return this.#json(
      this.#http.post(this.#human("/work-items/board"), { json: query }),
      BoardSchema,
    )
  }
  search(text: string, kinds: readonly SearchKind[], cursor: string | null = null) {
    return this.#json(
      this.#http.post(this.#human("/search"), { json: { text, kinds, limit: 50, cursor } }),
      SearchPageSchema,
    )
  }
  async releaseSnapshot(snapshotId: string): Promise<void> {
    await this.#http.delete(
      this.#human(`/query-snapshots/${encodeURIComponent(z.string().uuid().parse(snapshotId))}`),
    )
  }

  async command(options: CommandOptions) {
    const commandId = createBrowserUuid()
    return this.#json(
      this.#http[options.method](this.#commands(options.path), {
        json: {
          commandId,
          idempotencyKey: `web-${commandId}`,
          baseRevision: options.baseRevision,
          payload: options.payload,
        },
      }),
      EntityIdResultSchema,
    )
  }

  async validateImport(bytes: Uint8Array, commandId: string) {
    return this.#json(
      this.#http.post(`${this.#commands("/imports")}?mode=validate`, {
        body: Uint8Array.from(bytes).buffer,
        headers: {
          "content-type": "application/x-ndjson",
          "command-id": commandId,
          "idempotency-key": `import-${commandId}`,
        },
      }),
      ImportValidationSchema,
    )
  }

  async commitImport(bytes: Uint8Array, commandId: string, validationToken: string) {
    return this.#json(
      this.#http.post(`${this.#commands("/imports")}?mode=commit`, {
        body: Uint8Array.from(bytes).buffer,
        headers: {
          "content-type": "application/x-ndjson",
          "command-id": commandId,
          "idempotency-key": `import-${commandId}`,
          "validation-token": validationToken,
        },
      }),
      ImportCommitSchema,
    )
  }

  async exportData(options: ExportRequest): Promise<Blob> {
    try {
      return await this.#http.post(this.#human("/export"), { json: options }).blob()
    } catch (error) {
      if (error instanceof HTTPError)
        throw new ApiError(
          error.response.status,
          "export_failed",
          safeMessage("export_failed", error.response.status),
          {},
        )
      throw error
    }
  }
}
