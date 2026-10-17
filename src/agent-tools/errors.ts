export class WorkspaceToolConfigurationError extends Error {
  override readonly name = "WorkspaceToolConfigurationError"
}

export class WorkspaceToolHttpError extends Error {
  override readonly name = "WorkspaceToolHttpError"
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`Workspace API request failed (${status}, ${code})`)
    this.status = status
    this.code = code
  }
}
