import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import { z } from "zod"
import { BoardSchema, ProjectPageSchema, QueryPageSchema } from "../src/contracts/r4/index.ts"
import { SearchPageSchema } from "../src/contracts/r4/search.ts"
import {
  type ContinuationFixture,
  createContinuationFixture,
} from "./postgres-r4-continuation-fixture.ts"

const ErrorSchema = z.strictObject({
  error: z.object({ code: z.enum(["snapshot_stale", "snapshot_expired"]) }).loose(),
})
const surfaces = ["work", "project", "board", "search"] as const
let runtime: ContinuationFixture

beforeEach(async () => {
  runtime = await createContinuationFixture()
})

afterEach(async () => runtime.close())

test("released continuation snapshots return typed stale conflicts on every surface", async () => {
  // Given
  const continuations = await runtime.firstPages()
  for (const surface of surfaces) {
    const released = await runtime.release(continuations[surface].snapshotId)
    assert.equal(released.status, 204)
  }

  // When
  const responses = await Promise.all(
    surfaces.map((surface) => runtime.continuePage(surface, continuations[surface].cursor)),
  )

  // Then
  await assertConflicts(responses, 409, "snapshot_stale")
})

test("database-expired continuation snapshots return typed expired conflicts on every surface", async () => {
  // Given
  const continuations = await runtime.firstPages()
  await runtime.expire(surfaces.map((surface) => continuations[surface].snapshotId))

  // When
  const responses = await Promise.all(
    surfaces.map((surface) => runtime.continuePage(surface, continuations[surface].cursor)),
  )

  // Then
  await assertConflicts(responses, 410, "snapshot_expired")
})

test("valid continuations retain frozen revisions on every surface", async () => {
  // Given
  const continuations = await runtime.firstPages()
  await runtime.updateEntities()

  // When
  const [workResponse, projectResponse, boardResponse, searchResponse] = await Promise.all([
    runtime.continuePage("work", continuations.work.cursor),
    runtime.continuePage("project", continuations.project.cursor),
    runtime.continuePage("board", continuations.board.cursor),
    runtime.continuePage("search", continuations.search.cursor),
  ])

  // Then
  assert.equal(workResponse.status, 200)
  assert.equal(projectResponse.status, 200)
  assert.equal(boardResponse.status, 200)
  assert.equal(searchResponse.status, 200)
  const work = QueryPageSchema.parse(await workResponse.json())
  const project = ProjectPageSchema.parse(await projectResponse.json())
  const board = BoardSchema.parse(await boardResponse.json())
  const search = SearchPageSchema.parse(await searchResponse.json())
  assert.deepEqual(
    work.items.map((item) => [item.revision, item.title]),
    [[1, "Frozen Work Zulu"]],
  )
  assert.deepEqual(
    project.items.map((item) => [item.revision, item.name]),
    [[1, "Frozen Project Zulu"]],
  )
  assert.deepEqual(
    board.columns.flatMap((column) => column.cards.map((card) => [card.revision, card.title])),
    [[1, "Frozen Work Zulu"]],
  )
  assert.equal(search.results[0]?.sourceRevision, 1)
  assert.match(search.results[0]?.title ?? "", /^Frozen Work/)
})

test("empty first pages remain successful on every surface", async () => {
  // Given / When
  const responses = await Promise.all(surfaces.map((surface) => runtime.emptyPage(surface)))

  // Then
  for (const response of responses) assert.equal(response.status, 200)
  assert.equal(QueryPageSchema.parse(await responses[0]?.json()).items.length, 0)
  assert.equal(ProjectPageSchema.parse(await responses[1]?.json()).items.length, 0)
  assert.equal(
    BoardSchema.parse(await responses[2]?.json()).columns.flatMap((column) => column.cards).length,
    0,
  )
  assert.equal(SearchPageSchema.parse(await responses[3]?.json()).results.length, 0)
})

async function assertConflicts(
  responses: readonly Response[],
  status: number,
  code: "snapshot_stale" | "snapshot_expired",
): Promise<void> {
  assert.deepEqual(
    responses.map((response) => response.status),
    responses.map(() => status),
  )
  for (const response of responses) {
    assert.equal(ErrorSchema.parse(await response.json()).error.code, code)
  }
}
