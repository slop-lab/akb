import type { Server } from "node:http"
import { z } from "zod"
import {
  WorkItemEnvelopeSchema,
  WorkItemListSchema,
} from "../src/http/work-item-response-schemas.ts"
import { createServer } from "../src/server.ts"
import { actorId, eventId, workItemId } from "../src/work-items/identifiers.ts"
import { InMemoryWorkItemStore, type StoreLimits } from "../src/work-items/in-memory-store.ts"

export type HttpFixture = {
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly close: () => Promise<void>
  readonly port: number
}

const ErrorCodeSchema = z.strictObject({
  error: z.object({ code: z.string() }).loose(),
})

export async function startHttpFixture(limits?: StoreLimits): Promise<HttpFixture> {
  const itemIds = ["work-item-1", "work-item-2", "work-item-3"]
  const eventIds = ["event-1", "event-2", "event-3", "event-4"]
  const store = new InMemoryWorkItemStore(
    {
      newWorkItemId: () => workItemId(itemIds.shift() ?? "work-item-fallback"),
      newEventId: () => eventId(eventIds.shift() ?? "event-fallback"),
      now: () => "2026-01-02T03:04:05.000Z",
    },
    limits,
  )
  const server = createServer(store)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("server did not expose a TCP address")
  }
  return {
    request: (path, init) => fetch(`http://127.0.0.1:${address.port}${path}`, init),
    close: () => closeServer(server),
    port: address.port,
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) =>
    server.close((error?: Error) => (error ? reject(error) : resolve())),
  )
}

export const VALID_CREATE_BODY = {
  title: "Ship the slice",
  accountableOwnerId: "human-1",
  actorId: actorId("actor-1"),
} as const

export function jsonRequest(body: unknown, idempotency?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotency === undefined ? {} : { "idempotency-key": idempotency }),
    },
    body: JSON.stringify(body),
  }
}

export async function readWorkItem(response: Response) {
  return WorkItemEnvelopeSchema.parse(await response.json())
}

export async function readList(response: Response) {
  return WorkItemListSchema.parse(await response.json())
}

export async function readErrorCode(response: Response): Promise<string> {
  return ErrorCodeSchema.parse(await response.json()).error.code
}
