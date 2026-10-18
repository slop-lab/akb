export function automationWorkerConfiguration(environment) {
  return {
    limit: boundedInteger(
      environment.AUTOMATION_BATCH_LIMIT,
      "AUTOMATION_BATCH_LIMIT",
      100,
      1,
      100,
    ),
    interval: boundedInteger(
      environment.AUTOMATION_POLL_MS,
      "AUTOMATION_POLL_MS",
      5000,
      100,
      300000,
    ),
  }
}

function boundedInteger(raw, name, fallback, minimum, maximum) {
  const value = raw ?? String(fallback)
  if (!/^\d+$/.test(value)) throw new TypeError(`${name} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`)
  }
  return parsed
}
