import type { RecurrenceSchedule } from "../contracts/automation/index.ts"

type LocalParts = {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly weekday: number
}

export function nextOccurrence(
  schedule: RecurrenceSchedule,
  timezone: string,
  previous: Date,
): Date {
  const local = parts(previous, timezone)
  switch (schedule.kind) {
    case "daily":
      return fromLocal(addDays(local, schedule.interval), timezone)
    case "weekly": {
      const days = ((schedule.weekday - local.weekday + 7) % 7) + 7 * (schedule.interval - 1)
      return fromLocal(addDays(local, days === 0 ? 7 * schedule.interval : days), timezone)
    }
    case "monthly": {
      const monthIndex = local.year * 12 + local.month - 1 + schedule.interval
      return fromLocal(
        {
          ...local,
          year: Math.floor(monthIndex / 12),
          month: (monthIndex % 12) + 1,
          day: schedule.day,
        },
        timezone,
      )
    }
    case "cron": {
      const [minuteText, hourText, , , weekdayText] = schedule.expression.split(" ")
      const minute = Number(minuteText)
      const hour = Number(hourText)
      const weekday = Number(weekdayText)
      for (let offset = 0; offset <= 7; offset += 1) {
        const candidate = addDays({ ...local, hour, minute }, offset)
        if (candidate.weekday !== weekday) continue
        const instant = fromLocal(candidate, timezone)
        if (instant.getTime() > previous.getTime()) return instant
      }
      return fromLocal(addDays({ ...local, hour, minute }, 7), timezone)
    }
    default:
      return assertNever(schedule)
  }
}

function parts(date: Date, timezone: string): LocalParts {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date)
  const value = (kind: Intl.DateTimeFormatPartTypes): number =>
    Number(values.find((part) => part.type === kind)?.value)
  const weekdayName = values.find((part) => part.type === "weekday")?.value
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName ?? "")
  if (weekday < 0) throw new RangeError("timezone weekday could not be resolved")
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    weekday,
  }
}

function addDays(value: LocalParts, days: number): LocalParts {
  const date = new Date(
    Date.UTC(value.year, value.month - 1, value.day + days, value.hour, value.minute),
  )
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    weekday: date.getUTCDay(),
  }
}

function fromLocal(value: LocalParts, timezone: string): Date {
  const nominal = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute)
  let candidate = nominal
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = parts(new Date(candidate), timezone)
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    )
    candidate += nominal - represented
  }
  const result = new Date(candidate)
  const actual = parts(result, timezone)
  if (
    actual.year !== value.year ||
    actual.month !== value.month ||
    actual.day !== value.day ||
    actual.hour !== value.hour ||
    actual.minute !== value.minute
  ) {
    // DST gaps advance to the first representable local minute instead of disabling the rule.
    let lower = nominal - 36 * 60 * 60 * 1_000
    let upper = nominal + 36 * 60 * 60 * 1_000
    while (upper - lower > 60_000) {
      const midpoint = Math.floor((lower + upper) / 120_000) * 60_000
      const represented = parts(new Date(midpoint), timezone)
      const localTimestamp = Date.UTC(
        represented.year,
        represented.month - 1,
        represented.day,
        represented.hour,
        represented.minute,
      )
      if (localTimestamp >= nominal) upper = midpoint
      else lower = midpoint + 60_000
    }
    return new Date(upper)
  }
  return result
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported recurrence schedule: ${JSON.stringify(value)}`)
}
