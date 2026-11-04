/**
 * Error taxonomy for browser-repos.
 *
 * The engineering rules require surfacing storage, path, and (later) network
 * errors *distinctly*. Every error thrown by the library is a subclass of
 * {@link BrowserReposError} and carries a stable, machine-readable `code`, so
 * callers can branch on `code` without matching on message strings.
 */

/** Stable, machine-readable error codes. Extended as later slices add ops. */
export type BrowserReposErrorCode =
  /** A repository id / name was empty, malformed, or collided. */
  | 'INVALID_REPO_ID'
  /** A repository with the requested id already exists. */
  | 'REPO_EXISTS'
  /** No repository with the requested id exists. */
  | 'REPO_NOT_FOUND'
  /** A file path was empty, malformed, absolute, or escaped the repo root. */
  | 'INVALID_PATH'
  /** A file or directory was not found. */
  | 'NOT_FOUND'
  /** A commit was attempted with nothing staged in the index. */
  | 'NOTHING_STAGED'
  /** An underlying IndexedDB / filesystem operation failed. */
  | 'STORAGE_ERROR';

/** Base class for every error this library throws. */
export class BrowserReposError extends Error {
  readonly code: BrowserReposErrorCode;

  constructor(code: BrowserReposErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BrowserReposError';
    this.code = code;
    // Restore prototype chain for instanceof across transpile targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A repository id / name was empty, malformed, or collided. */
export class InvalidRepoIdError extends BrowserReposError {
  constructor(message: string) {
    super('INVALID_REPO_ID', message);
    this.name = 'InvalidRepoIdError';
  }
}

/** A repository with the requested id already exists. */
export class RepoExistsError extends BrowserReposError {
  constructor(id: string) {
    super('REPO_EXISTS', `A repository with id "${id}" already exists.`);
    this.name = 'RepoExistsError';
  }
}

/** No repository with the requested id exists. */
export class RepoNotFoundError extends BrowserReposError {
  constructor(id: string) {
    super('REPO_NOT_FOUND', `No repository with id "${id}" exists.`);
    this.name = 'RepoNotFoundError';
  }
}

/** A file path was empty, malformed, absolute, or escaped the repo root. */
export class InvalidPathError extends BrowserReposError {
  constructor(message: string) {
    super('INVALID_PATH', message);
    this.name = 'InvalidPathError';
  }
}

/** A file or directory was not found. */
export class NotFoundError extends BrowserReposError {
  constructor(path: string) {
    super('NOT_FOUND', `Path not found: "${path}".`);
    this.name = 'NotFoundError';
  }
}

/** A commit was attempted while the index held no staged changes. */
export class NothingStagedError extends BrowserReposError {
  constructor() {
    super('NOTHING_STAGED', 'Nothing staged to commit: stage changes before committing.');
    this.name = 'NothingStagedError';
  }
}

/** An underlying IndexedDB / filesystem operation failed unexpectedly. */
export class StorageError extends BrowserReposError {
  constructor(message: string, cause?: unknown) {
    super('STORAGE_ERROR', message, cause === undefined ? undefined : { cause });
    this.name = 'StorageError';
  }
}
