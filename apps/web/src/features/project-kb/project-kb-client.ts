import type { ProjectKbClient, ProjectKbRequest } from "@slop-lab/akb-project-kb/client"
import { createProjectKbClient } from "@slop-lab/akb-project-kb/client"
import { z } from "zod"
import type { Session } from "../../app/types.ts"

export function projectKbClientFor(session: Session): ProjectKbClient {
  return createProjectKbClient({
    workspaceId: session.bootstrap.workspace.id,
    transport: (request: ProjectKbRequest) =>
      session.api.feature(request.path, z.unknown(), {
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
      }),
  })
}
