import { z } from "zod"
import {
  type ContentDocument,
  CreateDocumentSchema,
  type CreateNotebook,
  CreateNotebookSchema,
  IdSchema,
  MutationResponseSchema,
  type NotebookResponse,
  NotebookResponseSchema,
  notebookPath,
  type Page,
  PageResponseSchema,
  PagesResponseSchema,
  SaveDocumentSchema,
  type TemplateId,
} from "./contracts.ts"
import { documentFromTemplate } from "./templates.ts"

export type ProjectKbRequest = {
  readonly method: "GET" | "POST" | "PATCH"
  readonly path: string
  readonly body?: unknown
}
export type ProjectKbTransport = (request: ProjectKbRequest) => Promise<unknown>
export type CommandIdentity = { readonly commandId: string; readonly idempotencyKey: string }
export type CreateDocument = {
  readonly parentPageId: string
  readonly title: string
  readonly templateId: TemplateId
}
export type SaveDocument = {
  readonly id: string
  readonly revision: number
  readonly title: string
  readonly document: ContentDocument
}
export interface ProjectKbClient {
  getNotebook(projectId: string): Promise<NotebookResponse>
  createNotebook(
    projectId: string,
    input: CreateNotebook,
    identity?: CommandIdentity,
  ): Promise<Page>
  listPages(parentPageId: string): Promise<readonly Page[]>
  getPage(pageId: string, revision?: number): Promise<Page>
  createPage(input: CreateDocument, identity?: CommandIdentity): Promise<Page>
  savePage(input: SaveDocument, identity?: CommandIdentity): Promise<Page>
}

export function createProjectKbClient(options: {
  readonly workspaceId: string
  readonly transport: ProjectKbTransport
}): ProjectKbClient {
  const workspace = encodeURIComponent(IdSchema.parse(options.workspaceId))
  const contentRoot = `/api/content/v1/workspaces/${workspace}/pages`
  const request = options.transport
  const getPage: ProjectKbClient["getPage"] = async (pageId, revision) => {
    const path = `${contentRoot}/${encodeURIComponent(IdSchema.parse(pageId))}`
    const suffix =
      revision === undefined ? "" : `/revisions/${z.number().int().positive().parse(revision)}`
    return PageResponseSchema.parse(await request({ method: "GET", path: `${path}${suffix}` })).page
  }
  async function mutate(
    call: {
      readonly path: string
      readonly method: "POST" | "PATCH"
      readonly baseRevision: number | null
      readonly payload: unknown
    },
    identity?: CommandIdentity,
  ): Promise<Page> {
    const command = identity ?? newCommandIdentity()
    const result = MutationResponseSchema.parse(
      await request({
        method: call.method,
        path: call.path,
        body: { ...command, baseRevision: call.baseRevision, payload: call.payload },
      }),
    )
    return getPage(result.result.id, result.revision)
  }
  return {
    getNotebook: async (projectId) =>
      NotebookResponseSchema.parse(
        await request({
          method: "GET",
          path: notebookPath(options.workspaceId, projectId),
        }),
      ),
    createNotebook: (projectId, input, identity) =>
      mutate(
        {
          method: "POST",
          path: notebookPath(options.workspaceId, projectId),
          baseRevision: null,
          payload: CreateNotebookSchema.parse(input),
        },
        identity,
      ),
    listPages: async (parentPageId) =>
      PagesResponseSchema.parse(
        await request({
          method: "GET",
          path: `${contentRoot}?parentPageId=${encodeURIComponent(IdSchema.parse(parentPageId))}`,
        }),
      ).pages,
    getPage,
    createPage: (input, identity) => {
      const parsed = CreateDocumentSchema.parse(input)
      return mutate(
        {
          method: "POST",
          path: contentRoot,
          baseRevision: null,
          payload: {
            parentPageId: parsed.parentPageId,
            spaceId: null,
            title: parsed.title,
            document: documentFromTemplate(parsed.templateId),
          },
        },
        identity,
      )
    },
    savePage: (input, identity) => {
      const parsed = SaveDocumentSchema.parse({
        id: input.id,
        revision: input.revision,
        title: input.title,
        document: input.document,
      })
      return mutate(
        {
          method: "PATCH",
          path: `${contentRoot}/${encodeURIComponent(parsed.id)}`,
          baseRevision: parsed.revision,
          payload: { title: parsed.title, document: parsed.document },
        },
        identity,
      )
    },
  }
}

export function newCommandIdentity(): CommandIdentity {
  const commandId = globalThis.crypto.randomUUID()
  return { commandId, idempotencyKey: `project-kb-${commandId}` }
}

export { createHttpTransport, ProjectKbHttpError } from "./http-transport.ts"
