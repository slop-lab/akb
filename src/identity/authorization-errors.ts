export class AuthenticationRequiredError extends Error {
  override readonly name = "AuthenticationRequiredError"

  constructor() {
    super("authentication required")
  }
}

export class PermissionDeniedError extends Error {
  override readonly name = "PermissionDeniedError"

  constructor() {
    super("permission denied")
  }
}

export class WorkspaceNotFoundError extends Error {
  override readonly name = "WorkspaceNotFoundError"

  constructor() {
    super("workspace not found")
  }
}
