import type { ZodType } from "zod"
import {
  ArchivePayloadSchema,
  CommentCreatePayloadSchema,
  CommentUpdatePayloadSchema,
  EntityAccessPayloadSchema,
  LabelCreatePayloadSchema,
  LabelUpdatePayloadSchema,
  ProjectCreatePayloadSchema,
  ProjectUpdatePayloadSchema,
  RelationCreatePayloadSchema,
  RelationUpdatePayloadSchema,
  SavedViewCreatePayloadSchema,
  SavedViewUpdatePayloadSchema,
  SpaceAccessPayloadSchema,
  SpaceCreatePayloadSchema,
  SpaceUpdatePayloadSchema,
  WorkflowStateCreatePayloadSchema,
  WorkflowStateUpdatePayloadSchema,
  WorkflowUpdatePayloadSchema,
  WorkItemCreatePayloadSchema,
  WorkItemUpdatePayloadSchema,
} from "../contracts/r4/command-payloads.ts"
import type { CommandAction } from "../pm/commands/types.ts"

export type CommandToolSpec = {
  readonly action: CommandAction
  readonly method: "POST" | "PATCH" | "PUT"
  readonly path: string
  readonly payload: ZodType
  readonly create: boolean
  readonly description: string
}

export const COMMAND_TOOL_SPECS = [
  command("space.create", "POST", "/spaces", SpaceCreatePayloadSchema, true),
  command("space.update", "PATCH", "/spaces/:resourceId", SpaceUpdatePayloadSchema, false),
  command("space.access", "PUT", "/spaces/:resourceId/access", SpaceAccessPayloadSchema, false),
  command(
    "workflow.update",
    "PATCH",
    "/spaces/:parentId/workflow",
    WorkflowUpdatePayloadSchema,
    false,
  ),
  command(
    "workflow-state.create",
    "POST",
    "/spaces/:parentId/workflow/states",
    WorkflowStateCreatePayloadSchema,
    true,
  ),
  command(
    "workflow-state.update",
    "PATCH",
    "/spaces/:parentId/workflow/states/:resourceId",
    WorkflowStateUpdatePayloadSchema,
    false,
  ),
  command(
    "workflow-state.archive",
    "POST",
    "/spaces/:parentId/workflow/states/:resourceId/archive",
    ArchivePayloadSchema,
    false,
  ),
  command("label.create", "POST", "/spaces/:parentId/labels", LabelCreatePayloadSchema, true),
  command("label.update", "PATCH", "/labels/:resourceId", LabelUpdatePayloadSchema, false),
  command("label.archive", "POST", "/labels/:resourceId/archive", ArchivePayloadSchema, false),
  command("project.create", "POST", "/projects", ProjectCreatePayloadSchema, true),
  command("project.update", "PATCH", "/projects/:resourceId", ProjectUpdatePayloadSchema, false),
  command("project.archive", "POST", "/projects/:resourceId/archive", ArchivePayloadSchema, false),
  command("project.restore", "POST", "/projects/:resourceId/restore", ArchivePayloadSchema, false),
  command("work-item.create", "POST", "/work-items", WorkItemCreatePayloadSchema, true),
  command(
    "work-item.update",
    "PATCH",
    "/work-items/:resourceId",
    WorkItemUpdatePayloadSchema,
    false,
  ),
  command(
    "work-item.archive",
    "POST",
    "/work-items/:resourceId/archive",
    ArchivePayloadSchema,
    false,
  ),
  command(
    "work-item.restore",
    "POST",
    "/work-items/:resourceId/restore",
    ArchivePayloadSchema,
    false,
  ),
  command("relation.create", "POST", "/relations", RelationCreatePayloadSchema, true),
  command("relation.update", "PATCH", "/relations/:resourceId", RelationUpdatePayloadSchema, false),
  command(
    "relation.archive",
    "POST",
    "/relations/:resourceId/archive",
    ArchivePayloadSchema,
    false,
  ),
  command(
    "comment.create",
    "POST",
    "/entities/:parentId/comments",
    CommentCreatePayloadSchema,
    true,
  ),
  command("comment.update", "PATCH", "/comments/:resourceId", CommentUpdatePayloadSchema, false),
  command("saved-view.create", "POST", "/saved-views", SavedViewCreatePayloadSchema, true),
  command(
    "saved-view.update",
    "PATCH",
    "/saved-views/:resourceId",
    SavedViewUpdatePayloadSchema,
    false,
  ),
  command(
    "saved-view.archive",
    "POST",
    "/saved-views/:resourceId/archive",
    ArchivePayloadSchema,
    false,
  ),
  command("entity.access", "PUT", "/entities/:resourceId/access", EntityAccessPayloadSchema, false),
] as const satisfies readonly CommandToolSpec[]

function command(
  action: CommandAction,
  method: CommandToolSpec["method"],
  path: string,
  payload: ZodType,
  create: boolean,
): CommandToolSpec {
  return {
    action,
    method,
    path,
    payload,
    create,
    description: `Execute ${action}; do not retry automatically`,
  }
}
