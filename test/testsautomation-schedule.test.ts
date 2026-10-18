import assert from "node:assert/strict"
import { test } from "node:test"
import { nextOccurrence } from "../src/automation/schedule.ts"
import {
  RecurrenceCreateSchema,
  RecurrenceScheduleSchema,
} from "../src/contracts/automation/index.ts"

test("recurrence schedules advance daily, weekly, monthly, and cron in their timezone", () => {
  // Given
  const previous = new Date("2026-03-07T14:30:00.000Z")

  // When
  const daily = nextOccurrence({ kind: "daily", interval: 1 }, "America/New_York", previous)
  const weekly = nextOccurrence(
    { kind: "weekly", interval: 1, weekday: 6 },
    "America/New_York",
    previous,
  )
  const monthly = nextOccurrence(
    { kind: "monthly", interval: 1, day: 7 },
    "America/New_York",
    previous,
  )
  const cron = nextOccurrence(
    { kind: "cron", expression: "30 9 * * 0" },
    "America/New_York",
    previous,
  )

  // Then
  assert.equal(daily.toISOString(), "2026-03-08T13:30:00.000Z")
  assert.equal(weekly.toISOString(), "2026-03-14T13:30:00.000Z")
  assert.equal(monthly.toISOString(), "2026-04-07T13:30:00.000Z")
  assert.equal(cron.toISOString(), "2026-03-08T13:30:00.000Z")
})

test("daily recurrence advances to the first valid local minute across a DST gap", () => {
  // Given
  const previous = new Date("2026-03-07T07:30:00.000Z")

  // When
  const next = nextOccurrence({ kind: "daily", interval: 1 }, "America/New_York", previous)

  // Then
  assert.equal(next.toISOString(), "2026-03-08T07:00:00.000Z")
})

test("recurrence contracts reject invalid IANA zones and cron hour or minute fields", () => {
  // Given
  const recurrence = {
    templateId: "template:1",
    templateRevision: 1,
    targetSpaceId: "delivery",
    schedule: { kind: "daily", interval: 1 },
    timezone: "Not/A_Timezone",
    incompletePolicy: "create",
    nextRunAt: "2026-03-07T07:30:00.000Z",
    title: "Invalid schedule",
  }

  // When / Then
  assert.equal(RecurrenceCreateSchema.safeParse(recurrence).success, false)
  assert.equal(
    RecurrenceScheduleSchema.safeParse({ kind: "cron", expression: "60 24 * * 0" }).success,
    false,
  )
})
