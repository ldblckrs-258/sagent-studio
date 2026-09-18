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

export class MalformedBlobError extends CorruptVaultError {
  constructor(message = 'Encrypted blob is malformed.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'MalformedBlobError'
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

export class VaultStorageError extends VaultError {
  constructor(message = 'The browser refused to persist vault data.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultStorageError'
  }
}

export class VaultMigrationError extends VaultError {
  constructor(message = 'The vault settings version is not supported.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultMigrationError'
  }
}
