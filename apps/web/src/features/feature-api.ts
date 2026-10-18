import { z } from "zod"
import type { Session } from "../app/types.ts"
import { createBrowserUuid } from "../lib/browser-uuid.ts"

export const FeatureMutationSchema = z.object({
  result: z.record(z.string(), z.unknown()),
  revision: z.number().int().positive(),
})

export type FeatureMutation = z.infer<typeof FeatureMutationSchema>
export const EntityFeatureMutationSchema = FeatureMutationSchema.extend({
  result: z.object({ id: z.string() }).passthrough(),
})
export type EntityFeatureMutation = z.infer<typeof EntityFeatureMutationSchema>

export function workspaceFeaturePath(session: Session, feature: string, path: string): string {
  return `api/${feature}/v1/workspaces/${encodeURIComponent(session.bootstrap.workspace.id)}${path}`
}

export function featureCommand(
  session: Session,
  feature: string,
  path: string,
  method: "POST" | "PATCH" | "PUT",
  baseRevision: number | null,
  payload: unknown,
): Promise<FeatureMutation> {
  const commandId = createBrowserUuid()
  return session.api.feature(workspaceFeaturePath(session, feature, path), FeatureMutationSchema, {
    method,
    body: {
      commandId,
      idempotencyKey: `web-${commandId}`,
      baseRevision,
      payload,
    },
  })
}
