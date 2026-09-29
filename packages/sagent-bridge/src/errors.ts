import type { BridgeErrorCode } from './protocol.js'

export class BridgeError extends Error {
  readonly code: BridgeErrorCode

  constructor(code: BridgeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}
