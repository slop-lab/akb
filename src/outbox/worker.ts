import type { DestinationScope, OutboxRepository } from "./repository.ts"

export type DeliveryRepository = Pick<
  OutboxRepository,
  "claim" | "deliverToInbox" | "acknowledge" | "fail"
>

export type RunSummary = {
  readonly claimed: number
  readonly delivered: number
  readonly failed: number
}

export async function runDatabaseInboxWorker(
  repository: DeliveryRepository,
  scope: DestinationScope,
  options: { readonly drain: boolean; readonly signal?: AbortSignal },
): Promise<RunSummary> {
  let claimed = 0
  let delivered = 0
  let failed = 0
  const maximum = options.drain ? 100 : 1
  while (claimed < maximum && options.signal?.aborted !== true) {
    const delivery = await repository.claim(scope)
    if (delivery === undefined) break
    claimed += 1
    try {
      await repository.deliverToInbox(delivery)
    } catch (error) {
      const message = error instanceof Error ? error.message : "delivery failed"
      await repository.fail(delivery, message)
      failed += 1
      continue
    }
    if (await repository.acknowledge(delivery)) delivered += 1
    else failed += 1
  }
  return { claimed, delivered, failed }
}
