export class ChatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ChatError'
  }
}

export class ChatConfigError extends ChatError {
  constructor(message = 'The thread configuration is invalid.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'ChatConfigError'
  }
}

export class ChatThreadNotFoundError extends ChatError {
  constructor(id: string, options?: ErrorOptions) {
    super(`No thread exists with id "${id}".`, options)
    this.name = 'ChatThreadNotFoundError'
  }
}

export class ChatRunError extends ChatError {
  constructor(message = 'The assistant run failed.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'ChatRunError'
  }
}
