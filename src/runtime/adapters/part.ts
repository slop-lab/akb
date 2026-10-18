export type ReferenceWorkerRunStart = {
  readonly kind: "run.start"
  readonly runId: string
  readonly installationId: string
  readonly subjectRef: string
  readonly directiveRef: string
  readonly bootstrapHandle: string
  readonly callbackBaseUrl: string
  readonly runToken: string
  readonly leaseExpiresAt: string
  readonly protocolVersion: "runtime.v1"
  readonly generation: number
}

export type ReferenceWorkerCancel = {
  readonly kind: "run.cancel"
  readonly runId: string
  readonly generation: number
}

export type ReferenceWorkerMessage = ReferenceWorkerRunStart | ReferenceWorkerCancel

export type ReferenceWorkerResult =
  | { readonly kind: "accepted"; readonly runId: string; readonly generation: number }
  | { readonly kind: "completed"; readonly runId: string; readonly generation: number }
  | { readonly kind: "canceled"; readonly runId: string; readonly generation: number }

export interface ReferenceWorkerDriver {
  start(message: ReferenceWorkerRunStart, signal: AbortSignal): Promise<void>
  cancel(message: ReferenceWorkerCancel): Promise<void>
}

export interface ReferenceWorkerProtocol {
  handle(message: ReferenceWorkerMessage): Promise<ReferenceWorkerResult>
}

export function createPartReferenceWorkerAdapter(
  driver: ReferenceWorkerDriver,
): ReferenceWorkerProtocol {
  const controllers = new Map<string, AbortController>()
  return {
    async handle(message) {
      switch (message.kind) {
        case "run.start": {
          const controller = new AbortController()
          controllers.set(message.runId, controller)
          await driver.start(message, controller.signal)
          controllers.delete(message.runId)
          return { kind: "completed", runId: message.runId, generation: message.generation }
        }
        case "run.cancel": {
          controllers.get(message.runId)?.abort()
          await driver.cancel(message)
          controllers.delete(message.runId)
          return { kind: "canceled", runId: message.runId, generation: message.generation }
        }
        default:
          return assertNever(message)
      }
    },
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported worker message: ${JSON.stringify(value)}`)
}
