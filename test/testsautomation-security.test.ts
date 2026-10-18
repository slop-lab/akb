import assert from "node:assert/strict"
import { test } from "node:test"
import { createPinnedHttpsTransport, isPublicAddress } from "../src/automation/outgoing-worker.ts"
import { AnalyticsResponseSchema } from "../src/contracts/automation/index.ts"

test("outgoing address policy rejects non-public IPv4 and IPv6 ranges", () => {
  // Given
  const denied = [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1",
  ]

  // When / Then
  for (const address of denied) assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress("8.8.8.8"), true)
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true)
})

test("pinned HTTPS rejects a hostname when any resolved address is private", async () => {
  // Given
  const transport = createPinnedHttpsTransport(async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ])

  // When / Then
  await assert.rejects(
    transport.send({
      id: crypto.randomUUID(),
      idempotency_key: "stable-delivery-key",
      endpoint_kind: "extension",
      endpoint_id: "extension:test",
      url: "https://example.com/hook",
      method: "POST",
      body: {},
      headers: {},
      attempts: 1,
      lease_generation: 1,
      lease_owner: crypto.randomUUID(),
    }),
    /non-public address/,
  )
})

test("analytics response schema parses the public metric contract", () => {
  // Given
  const response = {
    metric: "throughput",
    value: 2,
    from: "2026-10-17T00:00:00.000Z",
    to: "2026-10-18T00:00:00.000Z",
  }

  // When
  const parsed = AnalyticsResponseSchema.parse(response)

  // Then
  assert.deepEqual(parsed, response)
})
