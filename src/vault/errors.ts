export class VaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultError'
  }
}

export class VaultLockedError extends VaultError {
  constructor(message = 'The vault is locked.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultLockedError'
  }
}

export class WrongPasswordError extends VaultError {
  constructor(message = 'Incorrect password.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'WrongPasswordError'
  }
}

export class CorruptVaultError extends VaultError {
  constructor(message = 'The vault data is corrupted.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'CorruptVaultError'
  }
}

export class InsecureContextError extends VaultError {
  constructor(
    message = 'WebCrypto is unavailable. A secure context (HTTPS or localhost) is required.',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'InsecureContextError'
  }
}

export class UnsupportedKdfError extends VaultError {
  constructor(algorithm: string, options?: ErrorOptions) {
    super(`Unsupported key derivation algorithm: ${algorithm}`, options)
    this.name = 'UnsupportedKdfError'
  }
}
