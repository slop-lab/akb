import type { ServerResponse } from "node:http"
import type { WorkItem } from "../work-items/model.ts"
import type { WorkItemStore } from "../work-items/store.ts"
import { parsePathSegment } from "./path-segment.ts"
import { invalidArgument, writeJson } from "./responses.ts"
import { WorkspacePathSchema } from "./schemas.ts"
import type { WorkItemCard } from "./work-item-response-schemas.ts"

export const WORK_ITEM_LIST_LIMIT = 100

export async function writeWorkItemList(
  response: ServerResponse,
  store: WorkItemStore,
  rawWorkspaceId: string | undefined,
): Promise<void> {
  const workspace = parsePathSegment(rawWorkspaceId, "workspaceId", WorkspacePathSchema)
  switch (workspace.kind) {
    case "invalid":
      invalidArgument(response, workspace.fieldErrors)
      return
    case "valid":
      break
    default:
      assertNever(workspace)
  }
  const result = await store.list(workspace.value, WORK_ITEM_LIST_LIMIT)
  const items = result.items.map(toCard)
  const omittedCount = result.matched - items.length
  writeJson(response, 200, {
    items,
    completeness: {
      returned: items.length,
      matched: result.matched,
      truncated: omittedCount > 0,
    },
    omitted:
      omittedCount > 0 ? [{ category: "work_item", count: omittedCount, reason: "budget" }] : [],
    nextCursor: null,
    estimatedTokens: estimateTokens(items),
  })
}

function toCard(item: WorkItem): WorkItemCard {
  const fields = {
    id: item.id,
    kind: "work_item",
    title: item.title,
    revision: item.revision,
    state: item.state,
    accountableOwnerId: item.accountableOwnerId,
    ...(item.spaceId === undefined ? {} : { spaceId: item.spaceId }),
  } satisfies Omit<WorkItemCard, "estimatedTokens">
  return { ...fields, estimatedTokens: estimateTokens(fields) }
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4)
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected path result: ${JSON.stringify(value)}`)
}
