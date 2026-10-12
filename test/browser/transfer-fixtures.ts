import { z } from "zod"
import type { AppFixture } from "./fixtures.ts"
import { expect } from "./fixtures.ts"

const EntityResultSchema = z.object({ result: z.object({ id: z.string().min(1) }) })

export async function createTransferSpace(
  app: AppFixture,
  id: string,
  key: string,
  name: string,
): Promise<void> {
  const response = await app.ownerCommand({
    method: "post",
    path: "/spaces",
    baseRevision: null,
    payload: {
      id,
      key,
      name,
      visibility: "private",
      description: "Owned transfer fixture",
      icon: null,
      leadId: null,
    },
  })
  expect(response.status()).toBe(201)
}

export async function createTransferProject(
  app: AppFixture,
  ownerId: string,
  spaceId: string,
  name: string,
  slug: string,
): Promise<string> {
  const response = await app.ownerCommand({
    method: "post",
    path: "/projects",
    baseRevision: null,
    payload: {
      name,
      slug,
      summary: "Owned transfer fixture",
      ownerId,
      leadIds: [],
      participatingSpaceIds: [spaceId],
      state: "active",
      health: "on_track",
      priority: "none",
      startDate: null,
      targetDate: null,
    },
  })
  expect(response.status()).toBe(201)
  return EntityResultSchema.parse(await response.json()).result.id
}

export async function createTransferProjectView(
  app: AppFixture,
  spaceId: string,
  projectId: string,
  name: string,
): Promise<void> {
  const response = await app.ownerCommand({
    method: "post",
    path: "/saved-views",
    baseRevision: null,
    payload: {
      name,
      access: "space",
      scopeSpaceId: spaceId,
      definition: {
        model: "r4",
        filter: { op: "eq", field: "projectId", value: projectId },
        search: null,
        sort: [{ field: "updatedAt", direction: "desc" }],
        includeArchived: true,
        page: { size: 50, cursor: null },
      },
    },
  })
  expect(response.status()).toBe(201)
}
