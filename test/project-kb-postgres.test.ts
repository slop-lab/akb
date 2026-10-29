import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { IdentityAdmin } from "../src/identity/admin.ts"
import {
  CommandResultSchema,
  NotebookResponseSchema,
  ProjectKbPostgresFixture,
  required,
} from "./project-kb-postgres-fixture.ts"

let fixture: ProjectKbPostgresFixture

before(async () => {
  fixture = await ProjectKbPostgresFixture.create()
})

after(async () => fixture.close())

test("GET returns null for a visible project before its notebook exists", async () => {
  // Given / When
  const response = await fixture.get(fixture.notebookPath(), fixture.viewerToken)

  // Then
  assert.equal(response.status, 200)
  assert.deepEqual(NotebookResponseSchema.parse(response.body), {
    projectId: fixture.projectId,
    notebook: null,
  })
})

test("POST atomically creates one ordinary root Page and replays the stored result", async () => {
  // Given
  const envelope = fixture.commandEnvelope(null, { title: "Album notebook" }, "notebook-create")

  // When
  const created = await fixture.request(
    fixture.notebookPath(),
    fixture.ownerToken,
    "POST",
    envelope,
  )
  const replay = await fixture.request(fixture.notebookPath(), fixture.ownerToken, "POST", envelope)
  const duplicate = await fixture.request(
    fixture.notebookPath(),
    fixture.ownerToken,
    "POST",
    fixture.commandEnvelope(null, { title: "Replacement notebook" }, "notebook-replacement"),
  )

  // Then
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(replay.status, 200, JSON.stringify(replay.body))
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body))
  const first = CommandResultSchema.parse(created.body)
  const repeated = CommandResultSchema.parse(replay.body)
  assert.equal(repeated.replayed, true)
  assert.equal(repeated.result.id, first.result.id)
  const notebook = NotebookResponseSchema.parse(
    (await fixture.get(fixture.notebookPath(), fixture.viewerToken)).body,
  )
  assert.equal(notebook.notebook?.id, first.result.id)
  assert.equal(notebook.notebook?.parentPageId, null)
  assert.deepEqual(
    notebook.notebook?.document.blocks.map(({ id, type }) => ({ id, type })),
    [
      { id: "heading", type: "heading" },
      { id: "body", type: "paragraph" },
    ],
  )
  const rows = await fixture.database.sql`select
    (select count(*)::integer from project_notebooks where project_id=${fixture.projectId}) mappings,
    (select count(*)::integer from entity_revisions where entity_id=${first.result.id}) revisions,
    (select count(*)::integer from entity_events_v1 where subject_id=${first.result.id}) events,
    (select count(*)::integer from entity_access_dependencies
      where entity_id=${first.result.id} and required_entity_id=${fixture.projectId}) dependencies`
  assert.deepEqual([...rows], [{ mappings: 1, revisions: 1, events: 1, dependencies: 1 }])
})

test("generic Page patch and restore preserve Project authority for the notebook tree", async () => {
  // Given
  const notebook = NotebookResponseSchema.parse(
    (await fixture.get(fixture.notebookPath(), fixture.ownerToken)).body,
  )
  const rootId = required(notebook.notebook?.id)
  assert.equal(
    (
      await fixture.command(
        fixture.contentPagePath(rootId),
        1,
        { title: "Album notebook revised" },
        "notebook-patch",
        "PATCH",
      )
    ).status,
    200,
  )
  assert.equal(
    (
      await fixture.command(
        "/api/content/v1/workspaces/workspace/pages",
        null,
        {
          pageId: "album-track-notes",
          parentPageId: rootId,
          title: "Track notes",
          document: { version: 1, blocks: [] },
        },
        "notebook-child",
      )
    ).status,
    201,
  )

  // When
  const restored = await fixture.command(
    `${fixture.contentPagePath(rootId)}/restore`,
    2,
    { revision: 1 },
    "notebook-restore",
  )

  // Then
  assert.equal(restored.status, 200, JSON.stringify(restored.body))
  assert.equal(
    (await fixture.get(fixture.contentPagePath(rootId), fixture.viewerToken)).status,
    200,
  )
  assert.equal(
    (await fixture.get(fixture.contentPagePath("album-track-notes"), fixture.viewerToken)).status,
    200,
  )
  const dependencies = await fixture.database.sql`select required.kind,dependency.required_entity_id
    from entity_access_dependencies dependency
    join entities required on required.id=dependency.required_entity_id
    where dependency.entity_id=${rootId} order by required.kind`
  assert.deepEqual([...dependencies], [{ kind: "project", required_entity_id: fixture.projectId }])
})

test("hidden Projects deny notebook and generic Page reads and replay reauthorizes management", async () => {
  // Given
  await new IdentityAdmin(fixture.database.sql).setPermissions({
    workspaceId: "workspace",
    principalId: "viewer",
    permissions: ["content.read"],
  })
  await fixture.database.sql`delete from membership_permissions
    where workspace_id='workspace' and principal_id='owner' and permission='project.manage'`
  const rootId = required(
    NotebookResponseSchema.parse(
      (await fixture.get(fixture.notebookPath(), fixture.ownerToken)).body,
    ).notebook?.id,
  )

  // When
  const hiddenNotebook = await fixture.get(fixture.notebookPath(), fixture.viewerToken)
  const hiddenRoot = await fixture.get(fixture.contentPagePath(rootId), fixture.viewerToken)
  const hiddenChild = await fixture.get(
    fixture.contentPagePath("album-track-notes"),
    fixture.viewerToken,
  )
  const deniedReplay = await fixture.request(
    fixture.notebookPath(),
    fixture.ownerToken,
    "POST",
    fixture.commandEnvelope(null, { title: "Album notebook" }, "notebook-create"),
  )

  // Then
  assert.equal(hiddenNotebook.status, 404)
  assert.equal(hiddenRoot.status, 404)
  assert.equal(hiddenChild.status, 404)
  assert.equal(deniedReplay.status, 404)
})

test("mapping constraints reject a second root and any reassignment", async () => {
  // Given
  const rootId = required(
    NotebookResponseSchema.parse(
      (await fixture.get(fixture.notebookPath(), fixture.ownerToken)).body,
    ).notebook?.id,
  )
  const secondRoot = await fixture.command(
    "/api/content/v1/workspaces/workspace/pages",
    null,
    {
      pageId: "second-notebook-root",
      title: "Second root",
      document: { version: 1, blocks: [] },
    },
    "second-notebook-root",
  )
  assert.equal(secondRoot.status, 201, JSON.stringify(secondRoot.body))

  // When / Then
  await assert.rejects(
    fixture.database.sql`update project_notebooks set page_id='album-track-notes'
      where project_id=${fixture.projectId}`,
    /immutable|reassignment/i,
  )
  await assert.rejects(
    fixture.database.sql`delete from project_notebooks where project_id=${fixture.projectId}`,
    /immutable/i,
  )
  await assert.rejects(
    fixture.database.sql`insert into project_notebooks (workspace_id,project_id,page_id)
      values ('workspace',${fixture.projectId},'second-notebook-root')`,
    /duplicate|unique/i,
  )
  const rows = await fixture.database
    .sql`select page_id from project_notebooks where project_id=${fixture.projectId}`
  assert.deepEqual([...rows], [{ page_id: rootId }])
})
