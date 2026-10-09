export class IdentityNotActiveError extends Error {
  override readonly name = "IdentityNotActiveError"

  constructor() {
    super("identity is not active")
  }
}

export class CredentialExpiryError extends Error {
  override readonly name = "CredentialExpiryError"

  constructor() {
    super("credential expiry must be in the future")
  }
}

export class CredentialNotFoundError extends Error {
  override readonly name = "CredentialNotFoundError"

  constructor() {
    super("credential was not found")
  }
}
