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
  /** A branch name was empty, malformed, or an otherwise invalid git ref. */
  | 'INVALID_BRANCH_NAME'
  /** No branch with the requested name exists. */
  | 'BRANCH_NOT_FOUND'
  /** A branch operation was refused because it targets the current branch. */
  | 'BRANCH_IN_USE'
  /** A checkout was refused because the working tree has uncommitted changes. */
  | 'UNCOMMITTED_CHANGES'
  /** An import archive was malformed, truncated, or an unsupported version. */
  | 'INVALID_ARCHIVE'
  /** An archive entry was rejected on import (path traversal, oversize, etc.). */
  | 'ARCHIVE_ENTRY_REJECTED'
  /** The browser storage quota was exceeded while writing. */
  | 'QUOTA_EXCEEDED'
  /** A repo known to the registry has no backing data — the store was lost. */
  | 'STORAGE_LOST'
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

/** A branch name was empty, malformed, or an otherwise invalid git ref. */
export class InvalidBranchNameError extends BrowserReposError {
  constructor(message: string) {
    super('INVALID_BRANCH_NAME', message);
    this.name = 'InvalidBranchNameError';
  }
}

/** No branch with the requested name exists. */
export class BranchNotFoundError extends BrowserReposError {
  constructor(name: string) {
    super('BRANCH_NOT_FOUND', `No branch named "${name}" exists.`);
    this.name = 'BranchNotFoundError';
  }
}

/**
 * A branch operation was refused because it targets the current branch, e.g.
 * deleting the branch that HEAD currently points at.
 */
export class BranchInUseError extends BrowserReposError {
  constructor(name: string) {
    super('BRANCH_IN_USE', `Cannot operate on "${name}" while it is the current branch.`);
    this.name = 'BranchInUseError';
  }
}

/**
 * A checkout was refused because the working tree holds uncommitted changes to
 * tracked files. The chosen, tested behavior for a switch that would otherwise
 * clobber unsaved work — commit or discard first.
 */
export class UncommittedChangesError extends BrowserReposError {
  constructor(target: string) {
    super(
      'UNCOMMITTED_CHANGES',
      `Cannot check out "${target}" with uncommitted changes in the working tree: commit or discard them first.`,
    );
    this.name = 'UncommittedChangesError';
  }
}

/**
 * An import archive was structurally invalid: bad magic, truncated, an
 * unsupported format version, or a malformed header. Distinct from
 * {@link ArchiveEntryRejectedError}, which is about a specific entry's content.
 */
export class InvalidArchiveError extends BrowserReposError {
  constructor(message: string, cause?: unknown) {
    super('INVALID_ARCHIVE', message, cause === undefined ? undefined : { cause });
    this.name = 'InvalidArchiveError';
  }
}

/**
 * An individual archive entry was rejected on import. This is a security
 * boundary: a path that tries to escape the repo root (`..`, an absolute path,
 * a backslash or drive-letter form, a NUL byte), or an entry that is malformed
 * or oversized, is refused rather than written. The partially-built repo is
 * rolled back so a rejected import leaves no repo behind.
 */
export class ArchiveEntryRejectedError extends BrowserReposError {
  constructor(message: string) {
    super('ARCHIVE_ENTRY_REJECTED', message);
    this.name = 'ArchiveEntryRejectedError';
  }
}

/**
 * The browser's storage quota was exceeded while writing to IndexedDB. This is
 * surfaced *distinctly* from a generic {@link StorageError} because the caller's
 * response differs: a quota error is actionable (free space, prune repos, ask
 * for persistent storage), whereas a generic storage fault usually is not. The
 * underlying `QuotaExceededError` / `DOMException` (name `QuotaExceededError` or
 * legacy code 22) is attached as `cause`.
 */
export class QuotaExceededError extends BrowserReposError {
  constructor(message: string, cause?: unknown) {
    super('QUOTA_EXCEEDED', message, cause === undefined ? undefined : { cause });
    this.name = 'QuotaExceededError';
  }
}

/**
 * A repository the registry knows about has no backing data — its IndexedDB
 * store was unexpectedly emptied or evicted (quota pressure, a cleared profile,
 * a browser storage reset). Surfaced *distinctly* so a caller never mistakes a
 * lost store for an empty-but-valid repo and silently returns the wrong answer;
 * instead it can offer recovery from an export. See
 * {@link RepoManager.checkIntegrity}.
 */
export class StorageLostError extends BrowserReposError {
  constructor(id: string, message?: string) {
    super(
      'STORAGE_LOST',
      message ??
        `Repository "${id}" is known to the registry but its backing store is empty or lost — the data was evicted or the store was cleared.`,
    );
    this.name = 'StorageLostError';
  }
}

/** An underlying IndexedDB / filesystem operation failed unexpectedly. */
export class StorageError extends BrowserReposError {
  constructor(message: string, cause?: unknown) {
    super('STORAGE_ERROR', message, cause === undefined ? undefined : { cause });
    this.name = 'StorageError';
  }
}
