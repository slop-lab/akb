export class RuntimeConflictError extends Error {
  override readonly name = "RuntimeConflictError"
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}

export class RunNotActiveError extends Error {
  override readonly name = "RunNotActiveError"

  constructor() {
    super("run_not_active")
  }
}

export class RuntimeNotFoundError extends Error {
  override readonly name = "RuntimeNotFoundError"

  constructor() {
    super("not_found")
  }
}

export class RuntimeAuthenticationError extends Error {
  override readonly name = "RuntimeAuthenticationError"

  constructor() {
    super("unauthenticated")
  }
}

export class RuntimeCapabilityError extends Error {
  override readonly name = "RuntimeCapabilityError"

  constructor() {
    super("capability_unavailable")
  }
}
