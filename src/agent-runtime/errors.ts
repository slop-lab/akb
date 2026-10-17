import type { Contracts } from "@slop-lab/part/reference/index.js"

export class AgentConfigurationError extends Error {
  override readonly name = "AgentConfigurationError"
  readonly failure: Contracts.Failure

  constructor(failure: Contracts.Failure) {
    super(`Part agent configuration failed: ${failure.code}`)
    this.failure = failure
  }
}

export class AgentObservationGapError extends Error {
  override readonly name = "AgentObservationGapError"
  readonly from: number
  readonly to: number
  readonly recovery: "snapshot" | "final-result" | "unavailable"

  constructor(from: number, to: number, recovery: "snapshot" | "final-result" | "unavailable") {
    super(`Part event observation gap ${from}-${to}; recovery=${recovery}`)
    this.from = from
    this.to = to
    this.recovery = recovery
  }
}

export class AgentInputError extends Error {
  override readonly name = "AgentInputError"

  constructor(message: string) {
    super(message)
  }
}

export class AgentRunAdmissionError extends Error {
  override readonly name = "AgentRunAdmissionError"
  readonly failure: Contracts.Failure

  constructor(failure: Contracts.Failure) {
    super(`Part run admission failed: ${failure.code}`)
    this.failure = failure
  }
}

export class AgentCleanupError extends Error {
  override readonly name = "AgentCleanupError"
  readonly unresolvedCount: number
  readonly errorCount: number

  constructor(unresolvedCount: number, errorCount: number) {
    super("Agent cleanup incomplete")
    this.unresolvedCount = unresolvedCount
    this.errorCount = errorCount
  }
}
