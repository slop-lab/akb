export type AutomationWorkerConfiguration = {
  readonly limit: number
  readonly interval: number
}

export function automationWorkerConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): AutomationWorkerConfiguration
