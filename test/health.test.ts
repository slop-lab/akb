import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "../src/server.js"

test("GET /health returns the stable health payload", async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("server did not expose a TCP address")
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/health`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: "ok" })
  await new Promise<void>((resolve, reject) =>
    server.close((error?: Error) => (error ? reject(error) : resolve())),
  )
})

test("POST /health returns a stable not-found payload", async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("server did not expose a TCP address")
  }

  const response = await fetch(`http://127.0.0.1:${address.port}/health`, { method: "POST" })
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: "not_found" })
  await new Promise<void>((resolve, reject) =>
    server.close((error?: Error) => (error ? reject(error) : resolve())),
  )
})
