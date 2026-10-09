import assert from "node:assert/strict"
import { test } from "node:test"
import { retryDelaySeconds } from "../src/outbox/policy.ts"
import type { ClaimedDelivery } from "../src/outbox/repository.ts"
import { type DeliveryRepository, runDatabaseInboxWorker } from "../src/outbox/worker.ts"
import { DestinationIdSchema } from "../src/outbox/cli.ts"
import { ReplayQuerySchema } from "../src/events/replay-query.ts"

test("retry backoff is exponential and capped when attempts increase", () => {
  // Given / When
  const delays = [1, 2, 3, 4, 5, 8].map(retryDelaySeconds)

  // Then
  assert.deepEqual(delays, [1, 2, 4, 8, 16, 60])
})

test("replay query accepts canonical bounded decimal values", () => {
  // Given / When
  const query = ReplayQuerySchema.parse({ after: "0", limit: "100" })

  // Then
  assert.deepEqual(query, { after: 0, limit: 100 })
})

test("replay query rejects noncanonical and duplicate values", () => {
  // Given
  const invalid = [
    { after: "01", limit: "10" },
    { after: "+1", limit: "10" },
    { after: "-1", limit: "10" },
    { after: "1.0", limit: "10" },
    { after: "1e2", limit: "10" },
    { after: " 1", limit: "10" },
    { after: ["0", "1"], limit: "10" },
    { after: "9007199254740992", limit: "10" },
    { limit: "10" },
    { after: "0", limit: "10", unknown: "value" },
    { after: "0", limit: "101" },
  ]

  // When / Then
  for (const query of invalid) assert.equal(ReplayQuerySchema.safeParse(query).success, false)
})

const delivery: ClaimedDelivery = {
  jobId: "00000000-0000-4000-8000-000000000001",
  eventId: "event-1",
  workspaceId: "workspace-1",
  destinationId: "destination-1",
  sequence: 1,
  eventType: "work_item.created",
  occurredAt: new Date("2026-10-09T12:00:00.000Z"),
  actorId: "actor-1",
  subjectId: "item-1",
  subjectRevision: 1,
  changedFields: null,
  leaseOwner: "00000000-0000-4000-8000-000000000002",
  leaseGeneration: 1,
  attempts: 1,
}

function repositoryWith(overrides: Partial<DeliveryRepository>): DeliveryRepository {
  return {
    claim: async (_scope: Parameters<DeliveryRepository["claim"]>[0]) => delivery,
    deliverToInbox: async (_delivery: Parameters<DeliveryRepository["deliverToInbox"]>[0]) =>
      undefined,
    acknowledge: async (_delivery: Parameters<DeliveryRepository["acknowledge"]>[0]) => true,
    fail: async (
      _delivery: Parameters<DeliveryRepository["fail"]>[0],
      _message: Parameters<DeliveryRepository["fail"]>[1],
    ) => true,
    ...overrides,
  }
}

test("worker reports a lost acknowledgement fence as a failed delivery", async () => {
  const repository = repositoryWith({
    claim: async () => delivery,
    acknowledge: async () => false,
  })

  const summary = await runDatabaseInboxWorker(repository, delivery, { drain: false })

  assert.deepEqual(summary, { claimed: 1, delivered: 0, failed: 1 })
})

test("worker reports a lost failure fence without recatching it as a sink failure", async () => {
  const repository = repositoryWith({
    claim: async () => delivery,
    deliverToInbox: async () => {
      throw new Error("sink unavailable")
    },
    fail: async () => false,
  })

  const summary = await runDatabaseInboxWorker(repository, delivery, { drain: false })

  assert.deepEqual(summary, { claimed: 1, delivered: 0, failed: 1 })
})

test("drain stops at 100 deliveries and leaves the next job unclaimed", async () => {
  let remaining = 101
  const repository = repositoryWith({
    claim: async () => {
      if (remaining === 0) return undefined
      remaining -= 1
      return delivery
    },
  })

  const summary = await runDatabaseInboxWorker(repository, delivery, { drain: true })

  assert.deepEqual(summary, { claimed: 100, delivered: 100, failed: 0 })
  assert.equal(remaining, 1)
})

test("an abort raised after acknowledgement stops drain between jobs", async () => {
  const controller = new AbortController()
  let claims = 0
  const repository = repositoryWith({
    claim: async () => {
      claims += 1
      return delivery
    },
    acknowledge: async () => {
      controller.abort()
      return true
    },
  })

  const summary = await runDatabaseInboxWorker(repository, delivery, {
    drain: true,
    signal: controller.signal,
  })

  assert.deepEqual(summary, { claimed: 1, delivered: 1, failed: 0 })
  assert.equal(claims, 1)
})

test("destination IDs trim and enforce 128 Unicode code points", () => {
  assert.equal(DestinationIdSchema.parse("  destination  "), "destination")
  assert.equal(DestinationIdSchema.safeParse("😀".repeat(128)).success, true)
  assert.equal(DestinationIdSchema.safeParse("😀".repeat(129)).success, false)
})
