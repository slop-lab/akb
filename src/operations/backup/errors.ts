export class BackupError extends Error {
  override readonly name = "BackupError"
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

export function backupError(code: string, message: string, cause?: unknown): BackupError {
  return new BackupError(code, message, cause === undefined ? undefined : { cause })
}
