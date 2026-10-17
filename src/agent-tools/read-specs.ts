import type { Contracts } from "@slop-lab/part/reference/index.js"
import { type ZodType, z } from "zod"
import {
  BoardRequestSchema,
  BoardSchema,
  BootstrapSchema,
  CommentSchema,
  HistoryEntrySchema,
  HumanWorkQuerySchema,
  ProjectPageSchema,
  ProjectQuerySchema,
  ProjectSchema,
  QueryPageSchema,
  RelationSchema,
  SavedViewSchema,
  SpaceConfigSchema,
  SpaceSchema,
  WorkItemDetailSchema,
} from "../contracts/r4/index.ts"
import { SearchPageSchema, SearchRequestPagedSchema } from "../contracts/r4/search.ts"
import {
  EmptyInputSchema,
  EntityInputSchema,
  SnapshotInputSchema,
  type ToolObject,
} from "./schemas.ts"

export type ReadToolSpec = {
  readonly id: string
  readonly description: string
  readonly input: ZodType
  readonly output: ZodType
  readonly request: (input: ToolObject) => ReadRequest
  readonly snapshot: boolean
}

export type ReadRequest = {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly body?: Contracts.Json
}

const SpacesSchema = z.strictObject({ spaces: z.array(SpaceSchema).readonly() })
const SavedViewsSchema = z.strictObject({ views: z.array(SavedViewSchema).readonly() })
const EntityListSchemas = {
  comments: z.array(CommentSchema).readonly(),
  relations: z.array(RelationSchema).readonly(),
  history: z.array(HistoryEntrySchema).readonly(),
} as const

export const READ_TOOL_SPECS: readonly ReadToolSpec[] = [
  read("workspace_bootstrap", "Read workspace bootstrap", EmptyInputSchema, BootstrapSchema, () =>
    get("bootstrap"),
  ),
  read("workspace_spaces", "List visible spaces", EmptyInputSchema, SpacesSchema, () =>
    get("spaces"),
  ),
  read(
    "space_config",
    "Read a space workflow and labels",
    EntityInputSchema,
    SpaceConfigSchema,
    (input) => get(`spaces/${segment(input, "id")}/config`),
  ),
  read("project_get", "Read a project", EntityInputSchema, ProjectSchema, (input) =>
    get(`projects/${segment(input, "id")}`),
  ),
  read("work_item_get", "Read a work item", EntityInputSchema, WorkItemDetailSchema, (input) =>
    get(`work-items/${segment(input, "id")}`),
  ),
  read(
    "entity_comments",
    "Read entity comments",
    EntityInputSchema,
    EntityListSchemas.comments,
    (input) => get(`entities/${segment(input, "id")}/comments`),
  ),
  read(
    "entity_relations",
    "Read entity relations",
    EntityInputSchema,
    EntityListSchemas.relations,
    (input) => get(`entities/${segment(input, "id")}/relations`),
  ),
  read(
    "entity_history",
    "Read entity history",
    EntityInputSchema,
    EntityListSchemas.history,
    (input) => get(`entities/${segment(input, "id")}/history`),
  ),
  read("saved_views", "List visible saved views", EmptyInputSchema, SavedViewsSchema, () =>
    get("saved-views"),
  ),
  read(
    "projects_query",
    "Query projects",
    ProjectQuerySchema,
    ProjectPageSchema,
    (input) => post("projects/query", input),
    true,
  ),
  read(
    "work_items_query",
    "Query work items",
    HumanWorkQuerySchema,
    QueryPageSchema,
    (input) => post("work-items/query", input),
    true,
  ),
  read(
    "work_items_board",
    "Read a work item board",
    BoardRequestSchema,
    BoardSchema,
    (input) => post("work-items/board", input),
    true,
  ),
  read(
    "workspace_search",
    "Search workspace entities",
    SearchRequestPagedSchema,
    SearchPageSchema,
    (input) => post("search", input),
    true,
  ),
  read("snapshot_release", "Release a query snapshot", SnapshotInputSchema, z.null(), () =>
    get(""),
  ),
]

function read(
  id: string,
  description: string,
  input: ZodType,
  output: ZodType,
  request: ReadToolSpec["request"],
  snapshot = false,
): ReadToolSpec {
  return { id, description, input, output, request, snapshot }
}

function get(path: string): ReadRequest {
  return { method: "GET", path: human(path) }
}

function post(path: string, body: ToolObject): ReadRequest {
  return { method: "POST", path: human(path), body }
}

function human(path: string): string {
  return `human/v1/workspaces/:workspaceId/${path}`
}

function segment(input: ToolObject, name: string): string {
  const value = input[name]
  if (typeof value !== "string") throw new TypeError(`Missing ${name}`)
  return encodeURIComponent(value)
}
