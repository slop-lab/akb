import assert from "node:assert/strict"
import test from "node:test"
import { createOwnedSnapshotRunner } from "../apps/web/src/hooks/snapshot-owner.ts"

test("owned snapshot replacement releases the current snapshot before querying", async () => {
  // Given
  const events: string[] = []
  const runner = createOwnedSnapshotRunner({
    releaseSnapshot: async (snapshotId: string) => {
      events.push(`release:${snapshotId}`)
    },
  })
  await runner.run(async () => ({ snapshot: { id: "first" } }))

  // When
  await runner.run(async () => {
    events.push("query")
    return { snapshot: { id: "second" } }
  })

  // Then
  assert.deepEqual(events, ["release:first", "query"])
})

test("a new owner waits for an unmounted owner's pending release", async () => {
  // Given
  let finishRelease: (() => void) | undefined
  const events: string[] = []
  const api = {
    releaseSnapshot: async () =>
      new Promise<void>((resolve) => {
        finishRelease = resolve
      }),
  }
  const previous = createOwnedSnapshotRunner(api)
  const next = createOwnedSnapshotRunner(api)
  await previous.run(async () => ({ snapshot: { id: "previous" } }))
  previous.dispose()

  // When
  const loading = next.run(async () => {
    events.push("query")
    return { snapshot: { id: "next" } }
  })
  await Promise.resolve()

  // Then
  assert.deepEqual(events, [])
  finishRelease?.()
  await loading
  assert.deepEqual(events, ["query"])
})
