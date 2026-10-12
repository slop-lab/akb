import { z } from "zod"

export type HttpRequest = (path: string, init: RequestInit) => Promise<Response>
type WorkflowCommand = {
  readonly path: string
  readonly method: "POST" | "PATCH"
  readonly baseRevision: number | null
  readonly payload: unknown
  readonly key: string
}

export function workflowCommand(request: HttpRequest, command: WorkflowCommand): Promise<Response> {
  return request(`/api/commands/v1/workspaces/w${command.path}`, {
    method: command.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      commandId: command.key,
      idempotencyKey: command.key,
      baseRevision: command.baseRevision,
      payload: command.payload,
    }),
  })
}

export async function exportSpace(request: HttpRequest, spaceId: string): Promise<string> {
  const response = await request("/api/human/v1/workspaces/w/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ includeArchived: false, spaceId }),
  })
  const bytes = await response.text()
  if (response.status !== 200) throw new TypeError(bytes)
  return bytes
}

export function records(bytes: string): readonly Record<string, unknown>[] {
  return bytes
    .trimEnd()
    .split("\n")
    .map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)))
}

export function retargetSpace(bytes: string, destinationId: string): string {
  const output = records(bytes).map((record) => {
    if (Reflect.get(record, "kind") === "space") {
      return { ...record, externalId: destinationId, key: "RST" }
    }
    return Reflect.get(record, "spaceId") === "delivery"
      ? { ...record, spaceId: destinationId }
      : record
  })
  return `${output.map((record) => JSON.stringify(record)).join("\n")}\n`
}

export function withoutWorkflowScope(bytes: string): string {
  const output = records(bytes).map(({ workflowStateScope: _, ...record }) => record)
  return `${output.map((record) => JSON.stringify(record)).join("\n")}\n`
}

export function workflowAttributes(bytes: string): readonly Record<string, unknown>[] {
  return records(bytes)
    .filter((record) => Reflect.get(record, "kind") === "workflow_state")
    .map(({ externalId: _, spaceId: __, ...record }) => record)
    .sort((left, right) =>
      z
        .string()
        .parse(Reflect.get(left, "name"))
        .localeCompare(z.string().parse(Reflect.get(right, "name"))),
    )
}
