import type { RestoreOutcome } from './journal'

export class WorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspaceError'
  }
}

export class WorkspaceUnsupportedError extends WorkspaceError {
  constructor(message = 'The File System Access API is unavailable in this browser.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspaceUnsupportedError'
  }
}

export class WorkspacePermissionError extends WorkspaceError {
  constructor(message = 'Permission to the workspace folder was not granted.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspacePermissionError'
  }
}

export class WorkspacePathError extends WorkspaceError {
  constructor(path: string, options?: ErrorOptions) {
    super(`The workspace path "${path}" is not allowed.`, options)
    this.name = 'WorkspacePathError'
  }
}

export class WorkspaceNotFoundError extends WorkspaceError {
  constructor(path: string, options?: ErrorOptions) {
    super(`No workspace entry exists at "${path}".`, options)
    this.name = 'WorkspaceNotFoundError'
  }
}

export class WorkspaceLimitError extends WorkspaceError {
  constructor(path: string, options?: ErrorOptions) {
    super(`The workspace entry "${path}" exceeds the size cap.`, options)
    this.name = 'WorkspaceLimitError'
  }
}

export class WorkspaceConflictError extends WorkspaceError {
  constructor(path: string, options?: ErrorOptions) {
    super(`The workspace entry "${path}" already exists.`, options)
    this.name = 'WorkspaceConflictError'
  }
}

export class WorkspaceInvalidInputError extends WorkspaceError {
  constructor(
    message = 'The workspace operation received invalid input.',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'WorkspaceInvalidInputError'
  }
}

export class RestoreApplyError extends WorkspaceError {
  readonly path: string
  readonly outcome: RestoreOutcome

  constructor(path: string, outcome: RestoreOutcome, options?: ErrorOptions) {
    super(`Restoring "${path}" failed.`, options)
    this.name = 'RestoreApplyError'
    this.path = path
    this.outcome = outcome
  }
}
