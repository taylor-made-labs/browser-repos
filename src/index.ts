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
 * Slice 3 adds local, offline branching on top of that:
 * - create a branch (from HEAD or a named ref), list branches, delete a
 *   branch, and report the current branch;
 * - checkout (switch) a branch: move HEAD and rewrite the working tree, so a
 *   file committed only on one branch is isolated from the others;
 * - branch-name validation and a typed error taxonomy for invalid names,
 *   missing branches, deleting the current branch, and uncommitted-change
 *   conflicts on checkout.
 *
 * Slice 4 adds lossless export/import on top of all of that:
 * - `repo.export()` serializes the ENTIRE repo — working tree, the full `.git`
 *   (all objects, refs, every branch, complete history), the index/staged
 *   state, and untracked files — byte-exact into one portable archive;
 * - `manager.importRepo(id, archive)` reconstructs a fresh repo that is
 *   byte-for-byte identical: same files + bytes, same branches, same commit
 *   oids and history, same staged + untracked state, same current branch;
 * - every archive entry path is validated on import (traversal / absolute /
 *   malformed / oversize entries are rejected with a typed error), and the
 *   archive is credential-free by construction.
 *
 * Slice 5 hardens durability on top of all of that, with evidence rather than
 * assumption (see `DURABILITY.md`):
 * - a per-repo mutation queue so two conflicting mutations on one repo
 *   serialize instead of racing on the shared `.git` index and silently losing
 *   an update;
 * - distinct typed errors for storage pressure — `QuotaExceededError` when a
 *   write exceeds the browser quota, kept separate from a generic
 *   `StorageError`;
 * - `RepoManager.checkIntegrity()` / `openRepoChecked()` to surface a lost or
 *   evicted store as `StorageLostError`, instead of reading it as an
 *   empty-but-valid repo and returning a silent wrong answer.
 *
 * Slice 6 is the dogfood-ready documentation slice. It does not change
 * behavior; it consolidates and documents the public surface for *outside*
 * adopters:
 * - this module is the single supported entry point — everything an adopter
 *   needs (the manager, the repo handle and its methods, every public type, and
 *   every error class) is re-exported here, and internals stay internal;
 * - the error taxonomy is completed with the remote/sync family
 *   (`NetworkError`, `CorsError`, `AuthError`, `DivergenceError`,
 *   `ConflictError`) so adopters can write `catch` handlers for the whole
 *   contract today — the classes exist and carry distinct `code`/`name`
 *   discriminators, but **no network code ships in this slice**;
 * - a top-level `README.md` documents install, a quickstart, the full API
 *   reference, the error table, and the durability caveats.
 *
 * Slice 7 adds optional remote sync — the real safety net against a browser
 * clear. Browser storage is *not* a backup; the {@link RemoteSyncTarget} port
 * (with its {@link GitHubSyncTarget} adapter) is how a caller pushes a repo's
 * git data to a remote and pulls it back. It is strictly opt-in and
 * caller-driven: the core carries no network code and no dependency on the
 * remote module, so nothing syncs unless the caller explicitly calls it. The
 * remote ops throw the remote error family defined above, and credentials come
 * from a caller-supplied per-request hook that the library never stores.
 */

/** Library semantic version, exposed for consumers and diagnostics. */
export const VERSION = '0.1.0';

export { RepoManager } from './repo-manager.js';
export type {
  RepoManagerOptions,
  RepoInfo,
  RepoIntegrity,
  IntegrityReport,
} from './repo-manager.js';

export { BrowserRepo } from './repo.js';
export type { DirEntry, RepoTransaction } from './repo.js';

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

export { BranchOps, assertValidBranchName } from './branch-ops.js';
export type { CreateBranchOptions } from './branch-ops.js';

export { exportRepo, importRepo, resolveImportPath } from './export-import.js';

export {
  packArchive,
  unpackArchive,
  ARCHIVE_FORMAT_VERSION,
  MAX_ENTRY_BYTES,
  MAX_ENTRIES,
} from './archive.js';
export type { ArchiveEntry, ArchiveHeader } from './archive.js';

export { normalizeRelPath } from './path.js';

export type { FsBackend, FsBackendFactory, PromiseFs } from './fs-backend.js';
export { lightningFsBackendFactory } from './fs-backend.js';

export {
  MutationQueue,
  MutationQueueRegistry,
  isQuotaExceeded,
  classifyStorageError,
} from './durability.js';
export type { StorageErrorKind } from './durability.js';

export {
  // Base — catch this to handle any error this library throws.
  BrowserReposError,
  // Repo lifecycle + path/validation.
  InvalidRepoIdError,
  RepoExistsError,
  RepoNotFoundError,
  InvalidPathError,
  NotFoundError,
  // Git ops.
  NothingStagedError,
  // Branches.
  InvalidBranchNameError,
  BranchNotFoundError,
  BranchInUseError,
  UncommittedChangesError,
  // Export / import.
  InvalidArchiveError,
  ArchiveEntryRejectedError,
  // Storage / durability.
  QuotaExceededError,
  StorageLostError,
  StorageError,
  // Remote / sync contract (classes ship now; network ops land in a later slice).
  NetworkError,
  CorsError,
  AuthError,
  DivergenceError,
  ConflictError,
} from './errors.js';
export type { BrowserReposErrorCode } from './errors.js';

// ---- Optional remote sync (slice 7). Opt-in; the core never imports this. ----
export { GitHubSyncTarget, redactCredentials } from './remote/index.js';
export type {
  RemoteSyncTarget,
  GitHubSyncTargetOptions,
  SyncFs,
  SyncCredentials,
  CredentialRequest,
  CredentialHook,
  SyncOptions,
  PushOptions,
  PullOptions,
  CloneOptions,
  PushOutcome,
} from './remote/index.js';
