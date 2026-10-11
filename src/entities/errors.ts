export class EntityNotFoundError extends Error {
  override readonly name = "EntityNotFoundError"
  readonly entityId: string

  constructor(entityId: string) {
    super("entity was not found")
    this.entityId = entityId
  }
}

export class EntityRevisionConflictError extends Error {
  override readonly name = "EntityRevisionConflictError"
  readonly expected: number
  readonly actual: number

  constructor(expected: number, actual: number) {
    super("entity revision does not match")
    this.expected = expected
    this.actual = actual
  }
}

export class CommandIdempotencyConflictError extends Error {
  override readonly name = "CommandIdempotencyConflictError"
  readonly idempotencyKey: string

  constructor(idempotencyKey: string) {
    super("idempotency key was already used for a different command")
    this.idempotencyKey = idempotencyKey
  }
}

export class CommandInvariantError extends Error {
  override readonly name = "CommandInvariantError"
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}
