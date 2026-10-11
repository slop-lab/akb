import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, request, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createWebAssetsHandler } from "../src/http/web-assets.ts"

test("web assets return 404 for a missing file while preserving SPA routes", async (context) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "web-assets-"))
  context.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "assets"))
  await writeFile(join(root, "index.html"), "<main>application</main>")
  await writeFile(join(root, "assets", "app.js"), "export const ready = true")
  const assets = await createWebAssetsHandler(root)
  const server = createServer((request, response) => {
    void assets(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(418)
        response.end()
      }
    })
  })
  context.after(() => closeServer(server))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new TypeError("missing address")
  const origin = `http://127.0.0.1:${address.port}`

  // When
  const route = await fetch(`${origin}/work/items/example`)
  const asset = await fetch(`${origin}/assets/missing.js`)
  const api = await fetch(`${origin}/api/example`)
  const encodedApi = await fetch(`${origin}/api%2Fexample`)
  const encodedName = await fetch(`${origin}/%61pi/example`)
  const encodedBackslash = await fetch(`${origin}/api%5Cexample`)
  const apiRoot = await fetch(`${origin}/api`)
  const malformed = await fetch(`${origin}/%`)
  const dotSegmentApi = await requestPath(origin, "/api/%2e%2e/example")

  // Then
  assert.equal(route.status, 200)
  assert.equal(await route.text(), "<main>application</main>")
  assert.equal(asset.status, 404)
  assert.equal(api.status, 418)
  assert.equal(encodedApi.status, 418)
  assert.equal(encodedName.status, 418)
  assert.equal(encodedBackslash.status, 418)
  assert.equal(apiRoot.status, 418)
  assert.equal(malformed.status, 400)
  assert.equal(await malformed.text(), "Invalid request path")
  assert.equal(dotSegmentApi, 418)
})

function requestPath(origin: string, path: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const pending = request(origin, { path }, (response) => {
      response.resume()
      response.once("end", () => resolve(response.statusCode))
    })
    pending.once("error", reject)
    pending.end()
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}
