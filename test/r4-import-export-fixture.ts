import { z } from "zod"

export function completeGraph(importId: string): readonly Readonly<Record<string, unknown>>[] {
  const definition = {
    model: "r4",
    filter: {
      op: "and",
      filters: [
        { op: "eq", field: "projectId", value: "project" },
        { op: "eq", field: "labelId", value: "label" },
      ],
    },
    search: null,
    sort: [{ field: "updatedAt", direction: "desc" }],
    includeArchived: false,
    page: { size: 50, cursor: null },
  }
  return [
    { kind: "manifest", version: 1, importId, workspaceId: "w" },
    {
      kind: "space",
      externalId: "space",
      key: "IMP",
      name: "Imported",
      visibility: "private",
      description: "Secret roadmap",
      icon: "rocket",
      leadId: "owner",
    },
    {
      kind: "workflow_state",
      externalId: "state",
      spaceId: "space",
      name: "Review",
      category: "started",
      color: "orange",
      position: 7,
      isDefault: false,
    },
    {
      kind: "project",
      externalId: "project",
      name: "Imported project",
      slug: "imported-project",
      summary: "Full summary",
      ownerId: "owner",
      leadIds: ["owner"],
      participatingSpaceIds: ["space"],
      state: "active",
      health: "at_risk",
      priority: "high",
      startDate: "2026-10-01",
      targetDate: "2026-10-31",
      completedAt: null,
      archivedAt: null,
    },
    {
      kind: "label",
      externalId: "label",
      spaceId: "space",
      name: "Imported",
      color: "blue",
      archivedAt: null,
    },
    {
      kind: "work_item",
      externalId: "parent",
      spaceId: "space",
      title: "Parent",
      description: "Parent body",
      type: "Milestone",
      priority: "urgent",
      ownerId: "owner",
      stateId: "state",
      projectId: "project",
      labelIds: ["label"],
      startDate: "2026-10-02",
      dueDate: "2026-10-20",
      completedAt: null,
      archivedAt: null,
    },
    {
      kind: "work_item",
      externalId: "work",
      spaceId: "space",
      title: "Imported work",
      description: "Child body",
      type: "Task",
      priority: "medium",
      ownerId: "owner",
      stateId: "state",
      projectId: "project",
      labelIds: ["label"],
      startDate: "2026-10-03",
      dueDate: "2026-10-18",
      completedAt: null,
      archivedAt: null,
    },
    {
      kind: "relation",
      externalId: "relation",
      fromId: "parent",
      toId: "work",
      relationType: "parent_of",
      archivedAt: null,
    },
    {
      kind: "comment",
      externalId: "comment",
      subjectId: "work",
      authorId: "owner",
      body: "Imported note",
      archivedAt: null,
    },
    {
      kind: "saved_view",
      externalId: "view",
      ownerId: "owner",
      name: "Imported view",
      access: "workspace",
      scopeSpaceId: null,
      definition,
      archivedAt: null,
    },
  ]
}

export async function importRequest(
  base: string,
  bearer: string,
  mode: "validate" | "commit",
  body: string,
  validationToken?: string,
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/x-ndjson",
    "command-id": "22222222-2222-4222-8222-222222222222",
    "idempotency-key": "roundtrip",
  }
  if (validationToken !== undefined) headers["validation-token"] = validationToken
  const response = await fetch(`${base}/api/commands/v1/workspaces/w/imports?mode=${mode}`, {
    method: "POST",
    headers,
    body,
  })
  return { response, body: parseObject(await response.text()) }
}

export function ndjson(records: readonly Readonly<Record<string, unknown>>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
}

export function parseObject(value: string): Readonly<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(value))
}

export function field(value: Readonly<Record<string, unknown>>, name: string): string {
  const result = value[name]
  if (typeof result !== "string") throw new TypeError(`${name} missing`)
  return result
}

export function pick(records: readonly Readonly<Record<string, unknown>>[], kind: string) {
  const record = records.find((candidate) => candidate["kind"] === kind)
  if (record === undefined) throw new TypeError(`${kind} missing`)
  return record
}
