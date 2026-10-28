export class InvalidContextSelectionError extends Error {
  override readonly name = "InvalidContextSelectionError"

  constructor() {
    super("invalid context selection")
  }
}

export class ContextBudgetExceededError extends Error {
  override readonly name = "ContextBudgetExceededError"
  readonly contentBytes: number
  readonly maxBytes: number

  constructor(contentBytes: number, maxBytes: number) {
    super("context byte budget exceeded")
    this.contentBytes = contentBytes
    this.maxBytes = maxBytes
  }
}
