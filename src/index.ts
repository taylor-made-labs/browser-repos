/**
 * browser-repos
 *
 * IndexedDB-backed, Git-compatible repository library for the browser.
 *
 * The core is framework-agnostic and free of UI, LLM calls, and app logic — it
 * is reusable outside the Skeleton Crew project. It is Manifest V3 compatible:
 * dependencies are bundled locally, nothing is loaded from a CDN at runtime,
 * and no `eval` is used.
 *
 * Slice 1 covers the repository lifecycle and offline file operations:
 * - create / open / list / delete multiple independent repositories, each in
 *   its own IndexedDB namespace so they never collide;
 * - write / read / list / delete files within a repo, with strict path
 *   validation (no traversal, no absolute escapes);
 * - durability across close + reopen, because IndexedDB persists.
 *
 * Slice 2 adds the offline half of git on top of that lifecycle:
 * - working-tree status (untracked / modified / staged / deleted);
 * - staging: stage a file, stage a removal, unstage a path;
 * - commit the index with caller-supplied author metadata (never a credential);
 * - list commit history newest-first, with an optional depth limit.
 *
 * Branches, checkout, and lossless export/import arrive in later slices behind
 * this same surface.
 */

/** Library semantic version, exposed for consumers and diagnostics. */
export const VERSION = '0.1.0';

export { RepoManager } from './repo-manager.js';
export type { RepoManagerOptions, RepoInfo } from './repo-manager.js';

export { BrowserRepo } from './repo.js';
export type { DirEntry } from './repo.js';

export { GitOps } from './git-ops.js';
export type {
  FileStatus,
  FileStatusEntry,
  StatusReport,
  CommitAuthor,
  CommitOptions,
  CommitEntry,
  LogOptions,
} from './git-ops.js';

export { normalizeRelPath } from './path.js';

export type { FsBackend, FsBackendFactory, PromiseFs } from './fs-backend.js';
export { lightningFsBackendFactory } from './fs-backend.js';

export {
  BrowserReposError,
  InvalidRepoIdError,
  RepoExistsError,
  RepoNotFoundError,
  InvalidPathError,
  NotFoundError,
  NothingStagedError,
  StorageError,
} from './errors.js';
export type { BrowserReposErrorCode } from './errors.js';
