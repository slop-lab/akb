import type { IncomingMessage } from "node:http"

export function isRequestAborted(request: IncomingMessage): boolean {
  return request.destroyed && (!request.complete || !request.readableEnded)
}
