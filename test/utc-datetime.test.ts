import assert from "node:assert/strict"
import { test } from "node:test"
import { UtcDateTimeSchema } from "../src/human-query/utc-datetime.ts"

test("database offset timestamps preserve their instant in canonical UTC", () => {
  const timestamp = "2026-10-11T10:30:00+05:45"
  const normalized = UtcDateTimeSchema.parse(timestamp)
  assert.equal(normalized, "2026-10-11T04:45:00.000Z")
})

test("native dates and UTC strings produce the same canonical representation", () => {
  const timestamp = "2026-10-11T04:45:00Z"
  assert.equal(UtcDateTimeSchema.parse(new Date(timestamp)), UtcDateTimeSchema.parse(timestamp))
})

test("invalid database timestamp values are rejected", () => {
  assert.equal(UtcDateTimeSchema.safeParse("not-a-date").success, false)
  assert.equal(UtcDateTimeSchema.safeParse(new Date(Number.NaN)).success, false)
})
