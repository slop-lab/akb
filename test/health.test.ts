import assert from "node:assert/strict"
import { test } from "node:test"
import { RouteNotFoundErrorSchema } from "../src/http/error-schemas.ts"
import { HealthResponseSchema } from "../src/http/work-item-response-schemas.ts"
import { createServer } from "../src/server.ts"

test("GET /health returns the stable health payload", async (context) => {
  const server = createServer()
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("server did not expose a TCP address")
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/health`)
  assert.equal(response.status, 200)
  assert.deepEqual(HealthResponseSchema.parse(await response.json()), { status: "ok" })
})

test("GET /health ignores the query string when routing", async (context) => {
  // Given
  const server = createServer()
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("server did not expose a TCP address")
  }

  // When
  const response = await fetch(`http://127.0.0.1:${address.port}/health?probe=1`)

  // Then
  assert.equal(response.status, 200)
  assert.deepEqual(HealthResponseSchema.parse(await response.json()), { status: "ok" })
})

test("POST /health returns a stable not-found payload", async (context) => {
  const server = createServer()
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("server did not expose a TCP address")
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/health`, { method: "POST" })
  assert.equal(response.status, 404)
  const body = RouteNotFoundErrorSchema.parse(await response.json())
  assert.equal(body.error.code, "not_found")
  assert.deepEqual(body.error.details, { method: "POST", path: "/health" })
})

test("unknown paths return a canonical not-found payload", async (context) => {
  // Given
  const server = createServer()
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("server did not expose a TCP address")
  }

  // When
  const response = await fetch(`http://127.0.0.1:${address.port}/missing`)

  // Then
  assert.equal(response.status, 404)
  const body = RouteNotFoundErrorSchema.parse(await response.json())
  assert.equal(body.error.code, "not_found")
  assert.deepEqual(body.error.details, { method: "GET", path: "/missing" })
})
