import assert from "node:assert/strict"
import { test } from "node:test"
import { IsoTimestampSchema } from "../src/work-items/identifiers.ts"

test("legacy UTC timestamps preserve minute, second, fraction, and leap-day precision", () => {
  const valid = [
    "2026-10-26T12:30Z",
    "2026-10-26T12:30:45Z",
    "2026-10-26T12:30:45.123Z",
    "2024-02-29T00:00Z",
  ]
  const invalid = [
    "2026-02-29T00:00Z",
    "2026-10-26T24:00Z",
    "2026-10-26T12:60Z",
    "2026-10-26T12:30",
    "2026-10-26T12:30+01:00",
  ]
  assert.deepEqual(
    valid.map((value) => IsoTimestampSchema.safeParse(value).success),
    valid.map(() => true),
  )
  assert.deepEqual(
    invalid.map((value) => IsoTimestampSchema.safeParse(value).success),
    invalid.map(() => false),
  )
})
