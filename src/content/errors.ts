import { CommandInvariantError } from "../entities/errors.ts"

export class ContentInvariantError extends CommandInvariantError {
  override readonly name = "CommandInvariantError"

  constructor(code: string) {
    super(code)
  }
}

export class PageNotFoundError extends Error {
  override readonly name = "PageNotFoundError"
  readonly pageId: string

  constructor(pageId: string) {
    super(`page_not_found:${pageId}`)
    this.pageId = pageId
  }
}

export class PageRevisionConflictError extends Error {
  override readonly name = "PageRevisionConflictError"
  readonly expected: number
  readonly actual: number

  constructor(expected: number, actual: number) {
    super(`page_revision_conflict:${expected}:${actual}`)
    this.expected = expected
    this.actual = actual
  }
}

export class ContentIdempotencyConflictError extends Error {
  override readonly name = "ContentIdempotencyConflictError"
  readonly key: string

  constructor(key: string) {
    super(`content_idempotency_conflict:${key}`)
    this.key = key
  }
}
