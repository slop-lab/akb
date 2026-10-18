import type { Sql } from "postgres"
import { type ContentAction, ContentCommandService } from "../../content/command-service.ts"
import {
  ArchivePageSchema,
  CreateInlineCommentSchema,
  CreatePageSchema,
  ImportPageSchema,
  PatchPageSchema,
  RestorePageSchema,
} from "../../contracts/content/requests.ts"
import {
  createFeatureCommandRouter,
  type FeatureCommandRoute,
  featureCommandRoute,
} from "../feature-command-router.ts"
import type { WorkspaceAuthenticatedRoute } from "../route-types.ts"

const PREFIX = "^/api/content/v1/workspaces/([^/]+)"

export const CONTENT_COMMAND_ROUTES: readonly FeatureCommandRoute<ContentAction>[] = [
  featureCommandRoute({
    method: "POST",
    pattern: new RegExp(`${PREFIX}/pages$`),
    action: "page.create",
    payload: CreatePageSchema,
    create: true,
  }),
  featureCommandRoute({
    method: "POST",
    pattern: new RegExp(`${PREFIX}/pages/import$`),
    action: "page.import",
    payload: ImportPageSchema,
    create: true,
  }),
  featureCommandRoute({
    method: "PATCH",
    pattern: new RegExp(`${PREFIX}/pages/([^/]+)$`),
    action: "page.patch",
    payload: PatchPageSchema,
    create: false,
    resourceCapture: 2,
  }),
  featureCommandRoute({
    method: "POST",
    pattern: new RegExp(`${PREFIX}/pages/([^/]+)/restore$`),
    action: "page.restore",
    payload: RestorePageSchema,
    create: false,
    resourceCapture: 2,
  }),
  featureCommandRoute({
    method: "POST",
    pattern: new RegExp(`${PREFIX}/pages/([^/]+)/archive$`),
    action: "page.archive",
    payload: ArchivePageSchema,
    create: false,
    resourceCapture: 2,
  }),
  featureCommandRoute({
    method: "POST",
    pattern: new RegExp(`${PREFIX}/pages/([^/]+)/comments$`),
    action: "comment.create",
    payload: CreateInlineCommentSchema,
    create: true,
    parentCapture: 2,
  }),
]

export function createContentCommandRoute(sql: Sql): WorkspaceAuthenticatedRoute {
  return createFeatureCommandRouter(sql, CONTENT_COMMAND_ROUTES, new ContentCommandService(sql))
}
