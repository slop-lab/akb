import type { ClaimedDelivery, DestinationScope } from "./repository.ts"

export type GenericDeliveryRepository<Delivery> = {
  readonly claim: (scope: DestinationScope) => Promise<Delivery | undefined>
  readonly deliverToInbox: (delivery: Delivery) => Promise<void>
  readonly acknowledge: (delivery: Delivery) => Promise<boolean>
  readonly fail: (delivery: Delivery, error: string) => Promise<boolean>
}

export type DeliveryRepository = GenericDeliveryRepository<ClaimedDelivery>

export type RunSummary = {
  readonly claimed: number
  readonly delivered: number
  readonly failed: number
}

export async function runDatabaseInboxWorker<Delivery>(
  repository: GenericDeliveryRepository<Delivery>,
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
