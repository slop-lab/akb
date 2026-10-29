import "node:process"
import { createProjectKbClient, type ProjectKbClient } from "./client.ts"
import { createHttpTransport } from "./http-transport.ts"

/** Keep this entrypoint and its token provider in trusted server code, never in a browser bundle. */
export function createServerProjectKbClient(options: {
  readonly baseUrl: string
  readonly workspaceId: string
  readonly token: () => string | Promise<string>
}): ProjectKbClient {
  return createProjectKbClient({
    workspaceId: options.workspaceId,
    transport: createHttpTransport(options),
  })
}

export { ProjectKbHttpError } from "./http-transport.ts"
export type { ProjectKbClient, CommandIdentity } from "./client.ts"
