import type { Page } from "./model.ts"

export const CONTENT_API_PREFIX = "/api/content/v1/workspaces" as const

export interface PageProjectionProvider {
  project(page: Page): Promise<Readonly<Record<string, unknown>>>
}

export const CONTENT_PATHS = {
  pages: "/pages",
  page: "/pages/:pageId",
  history: "/pages/:pageId/history",
  restore: "/pages/:pageId/restore",
  archive: "/pages/:pageId/archive",
  comments: "/pages/:pageId/comments",
  backlinks: "/pages/:pageId/backlinks",
  presence: "/pages/:pageId/presence",
  export: "/pages/:pageId/export",
  import: "/pages/import",
} as const
