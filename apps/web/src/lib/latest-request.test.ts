import { expect, test } from "vitest"
import { LatestRequest } from "./latest-request.ts"

test("only the latest request can publish a result", () => {
  const requests = new LatestRequest()
  const first = requests.start()
  expect(first()).toBe(true)
  const second = requests.start()
  expect(first()).toBe(false)
  expect(second()).toBe(true)
})

test("changing inputs invalidates the pending request", () => {
  const requests = new LatestRequest()
  const pending = requests.start()
  requests.invalidate()
  expect(pending()).toBe(false)
  expect(requests.start()()).toBe(true)
})
