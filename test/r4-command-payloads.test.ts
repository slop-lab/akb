import assert from "node:assert/strict"
import { test } from "node:test"
import {
  CommentCreatePayloadSchema,
  EntityAccessPayloadSchema,
  ProjectCreatePayloadSchema,
  RelationCreatePayloadSchema,
  SavedViewCreatePayloadSchema,
  SpaceAccessPayloadSchema,
  SpaceCreatePayloadSchema,
  WorkflowStateCreatePayloadSchema,
  WorkItemCreatePayloadSchema,
} from "../src/contracts/r4/command-payloads.ts"

test("command payload schemas reject actors and unknown fields", () => {
  // Given
  const space = {
    id: "engineering",
    key: "ENG",
    name: "Engineering",
    visibility: "private",
    description: "Product engineering",
    icon: null,
    leadId: null,
  }

  // When
  const valid = SpaceCreatePayloadSchema.safeParse(space)
  const actor = SpaceCreatePayloadSchema.safeParse({ ...space, actorId: "owner" })

  // Then
  assert.equal(valid.success, true)
  assert.equal(actor.success, false)
})

test("project and Work payloads enforce date order and canonical priorities", () => {
  // Given
  const project = {
    name: "Launch",
    slug: "launch",
    summary: "",
    ownerId: "owner",
    leadIds: [],
    participatingSpaceIds: ["engineering"],
    state: "active",
    health: "on_track",
    priority: "high",
    startDate: "2026-02-02",
    targetDate: "2026-02-01",
  }
  const work = {
    spaceId: "engineering",
    title: "Ship",
    accountableOwnerId: "owner",
    description: "",
    type: "Task",
    workflowStateId: "state",
    projectId: null,
    priority: "urgent",
    labelIds: [],
    startDate: "2026-02-01",
    dueDate: "2026-02-02",
  }

  // When
  const invalidProject = ProjectCreatePayloadSchema.safeParse(project)
  const validWork = WorkItemCreatePayloadSchema.safeParse(work)

  // Then
  assert.equal(invalidProject.success, false)
  assert.equal(validWork.success, true)
})

test("relation comments workflow ACL and Saved View payloads are strict", () => {
  // Given
  const cases = [
    RelationCreatePayloadSchema.safeParse({
      fromEntityId: "b",
      relationType: "related_to",
      toEntityId: "a",
    }),
    CommentCreatePayloadSchema.safeParse({ body: "plain text", subjectId: "unexpected" }),
    WorkflowStateCreatePayloadSchema.safeParse({
      name: "Review",
      category: "started",
      color: "#2563EB",
      position: 2,
      isDefault: false,
    }),
    EntityAccessPayloadSchema.safeParse({ mode: "restricted", allowances: [] }),
    SavedViewCreatePayloadSchema.safeParse({
      name: "Mine",
      access: "private",
      scopeSpaceId: null,
      definition: {
        model: "r4",
        filter: null,
        search: null,
        sort: [{ field: "updatedAt", direction: "desc" }],
        includeArchived: false,
        page: { size: 50, cursor: null },
      },
    }),
  ]

  // When
  const outcomes = cases.map((result) => result.success)

  // Then
  assert.deepEqual(outcomes, [false, false, true, false, true])
})

test("access payloads accept only the 15 canonical permission atoms", () => {
  // Given
  const canonical = [
    "work.read",
    "work.create",
    "work.update",
    "work.assign",
    "space.read",
    "space.manage",
    "project.read",
    "project.manage",
    "comment.create",
    "comment.update",
    "relation.manage",
    "view.read",
    "view.manage",
    "history.read",
    "acl.manage",
  ]

  // When
  const space = SpaceAccessPayloadSchema.safeParse({
    principalId: "member",
    permissions: canonical,
  })
  const entity = EntityAccessPayloadSchema.safeParse({
    mode: "restricted",
    allowances: [{ principalId: "member", permissions: ["work.read", "invented"] }],
  })

  // Then
  assert.equal(space.success, true)
  assert.equal(entity.success, false)
})
