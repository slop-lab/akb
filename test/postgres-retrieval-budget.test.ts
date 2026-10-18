import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { z } from "zod"
import { responseItemIds } from "./runtime-http-support.ts"
import { createRuntimeRegressionHarness, seedEntity } from "./runtime-regression-support.ts"

let harness: Awaited<ReturnType<typeof createRuntimeRegressionHarness>>

before(async () => {
  harness = await createRuntimeRegressionHarness()
  for (const id of [
    "page-a",
    "page-b",
    "delta-item-a",
    "delta-item-b",
    "delta-token-a",
    "delta-token-b",
  ] as const) {
    await seedEntity(harness.sql, id, id)
  }
})

after(async () => harness.close())

test("retrieval continuation does not skip an item that exceeds only the cumulative token budget", async () => {
  // Given
  const run = await harness.startRun("page-overflow")
  const request = {
    operation: "read_entities",
    query: "",
    ids: ["page-a", "page-b"],
    kinds: ["work_item"],
    projection: "ref",
    budget: { maxItems: 2, maxTokens: 32 },
    cursor: null,
  }

  // When
  const first = await harness.client.runtimeJson(run.runId, "/retrieval", run.token, request)
  const second = await harness.client.runtimeJson(run.runId, "/retrieval", run.token, {
    ...request,
    cursor: z.string().parse(first["nextCursor"]),
  })

  // Then
  assert.deepEqual([...responseItemIds(first), ...responseItemIds(second)], ["page-a", "page-b"])
  assert.equal(second["nextCursor"], null)
})

test("delta maxItems carries an unreturned revision into the next receipt", async () => {
  // Given
  const run = await harness.startRun("delta-items")
  const ids = ["delta-item-a", "delta-item-b"] as const
  const receipt = await initialReceipt(run, ids)
  await updateBoth(ids)

  // When
  const first = await delta(run, receipt, { maxItems: 1, maxTokens: 100_000 })
  const second = await delta(run, z.string().parse(first["nextReceipt"]), {
    maxItems: 1,
    maxTokens: 100_000,
  })

  // Then
  assert.deepEqual([...changedIds(first), ...changedIds(second)].sort(), [
    "delta-item-a",
    "delta-item-b",
  ])
  assertBudgetOmission(first)
})

test("delta maxTokens carries an unreturned revision into the next receipt", async () => {
  // Given
  const run = await harness.startRun("delta-tokens")
  const ids = ["delta-token-a", "delta-token-b"] as const
  const receipt = await initialReceipt(run, ids)
  await updateBoth(ids)

  // When
  const first = await delta(run, receipt, { maxItems: 10, maxTokens: 32 })
  const second = await delta(run, z.string().parse(first["nextReceipt"]), {
    maxItems: 10,
    maxTokens: 32,
  })

  // Then
  assert.deepEqual([...changedIds(first), ...changedIds(second)].sort(), [
    "delta-token-a",
    "delta-token-b",
  ])
  assertBudgetOmission(first)
})

async function initialReceipt(
  run: { readonly runId: string; readonly token: string },
  ids: readonly [string, string],
) {
  const page = await harness.client.runtimeJson(run.runId, "/retrieval", run.token, {
    operation: "read_entities",
    query: "",
    ids,
    kinds: ["work_item"],
    projection: "ref",
    budget: { maxItems: 2, maxTokens: 10_000 },
    cursor: null,
  })
  return z.string().parse(page["receiptId"])
}

async function updateBoth(ids: readonly [string, string]): Promise<void> {
  for (const id of ids) {
    await harness.sql`insert into entity_revisions
      (entity_id,revision,schema_version,canonical_snapshot,actor_id,created_at,digest)
      values (${id},2,'test.v1',${harness.sql.json({ id, title: `${id}-2` })},
        'runtime-owner',clock_timestamp(),repeat('b',64))`
    await harness.sql`update entities set current_revision=2,updated_at=clock_timestamp()
      where id=${id}`
  }
}

function delta(
  run: { readonly runId: string; readonly token: string },
  sinceReceipt: string,
  budget: { readonly maxItems: number; readonly maxTokens: number },
) {
  return harness.client.runtimeJson(run.runId, "/retrieval/delta", run.token, {
    sinceReceipt,
    kinds: ["work_item"],
    projection: "ref",
    budget,
  })
}

function changedIds(response: Readonly<Record<string, unknown>>): readonly string[] {
  return z
    .array(z.object({ id: z.string() }))
    .parse(response["changed"])
    .map((item) => item.id)
}

function assertBudgetOmission(response: Readonly<Record<string, unknown>>): void {
  assert.deepEqual(response["omitted"], [
    { category: "authorized_object", count: 1, reason: "budget" },
  ])
}
