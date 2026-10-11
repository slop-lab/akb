import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import {
  createRequestTelemetryHandler,
  markResponseError,
  type RequestTelemetry,
} from "../src/http/request-telemetry.ts"

test("request telemetry records an exact safe shape under actual HTTP", async (context) => {
  // Given
  const events: RequestTelemetry[] = []
  const secret = "SecretSigningKey-sourceIDs-token"
  const server = createServer(
    createRequestTelemetryHandler(
      (_request, response) => {
        markResponseError(response, "invalid_argument")
        response.writeHead(400, { "content-type": "application/json" })
        response.end(JSON.stringify({ title: secret }))
      },
      {
        sink: (event) => events.push(event),
        now: (() => {
          let milliseconds = 0
          return () => {
            milliseconds += 5
            return new Date(milliseconds).toISOString()
          }
        })(),
        newRequestId: () => "00000000-0000-4000-8000-000000000001",
      },
    ),
  )
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("missing address")

  // When
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/events/v1/workspaces/private-id/events?token=${secret}`,
    { headers: { authorization: `Bearer ${secret}`, cookie: secret, "x-request-id": secret } },
  )
  await response.text()

  // Then
  assert.equal(response.headers.get("x-request-id"), "00000000-0000-4000-8000-000000000001")
  const [event] = events
  assert.ok(event)
  assert.deepEqual(
    { ...event, bytes: undefined },
    {
      timestamp: "1970-01-01T00:00:00.010Z",
      level: "info",
      event: "http.request",
      requestId: "00000000-0000-4000-8000-000000000001",
      method: "GET",
      routeTemplate: "/api/events/v1/workspaces/:workspaceId/events",
      status: 400,
      durationMs: 5,
      bytes: undefined,
      errorCode: "invalid_argument",
    },
  )
  assert.ok(event.bytes > Buffer.byteLength(JSON.stringify({ title: secret })))
  assert.doesNotMatch(
    JSON.stringify(events),
    /private-id|SecretSigningKey|sourceIDs|token|authorization|cookie/,
  )
})
