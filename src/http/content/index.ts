import type { Sql } from "postgres"
import type { PageProjectionProvider } from "../../contracts/content/routes.ts"
import type { WorkspaceAuthenticatedRoute } from "../route-types.ts"
import { createContentReadRoute } from "./read-route.ts"
import { createContentCommandRoute } from "./routes.ts"

export function createContentRoutes(
  sql: Sql,
  projectionProvider?: PageProjectionProvider,
): readonly WorkspaceAuthenticatedRoute[] {
  return [createContentCommandRoute(sql), createContentReadRoute(sql, projectionProvider)]
}

export { CONTENT_COMMAND_ROUTES } from "./routes.ts"
