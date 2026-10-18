import type { IncomingMessage, ServerResponse } from "node:http"
import type { AuthenticatedPrincipal } from "../identity/types.ts"

export type WorkspaceAuthenticatedRoute = (
  request: IncomingMessage,
  response: ServerResponse,
  principal: AuthenticatedPrincipal,
) => Promise<boolean>

export type ApplicationRouteGroup = {
  readonly workspaceRoutes: readonly WorkspaceAuthenticatedRoute[]
}
