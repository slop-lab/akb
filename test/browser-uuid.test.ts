import assert from "node:assert/strict"
import test from "node:test"
import { uuidV4 } from "../apps/web/src/lib/browser-uuid.ts"

test("browser UUID generation does not require crypto.randomUUID", () => {
  const bytes = Uint8Array.from({ length: 16 }, (_, index) => index)

  assert.equal(uuidV4(bytes), "00010203-0405-4607-8809-0a0b0c0d0e0f")
})
