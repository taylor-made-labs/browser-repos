/**
 * The {@link RemoteSyncTarget} port — the pluggable contract for backing up and
 * syncing a repository's git data to and from a remote.
 *
 * Why this exists (and why it is optional). Browser storage is **not** a
 * backup: IndexedDB can be evicted under quota pressure, wiped by "clear
 * browsing data", or lost with a profile. A `RemoteSyncTarget` is how a caller
 * protects a repo against that — by pushing its git data to a real remote and
 * pulling it back. Nothing here runs unless the caller explicitly calls it: the
 * core repository (lifecycle, git ops, branches, export/import, durability)
 * carries no network code and no dependency on this module, so an app that
 * never syncs pays nothing and ships no network surface.
 *
 * Why it is a port. GitHub is one adapter ({@link import('./github.js').GitHubSyncTarget});
 * any other git host (or a test double) can implement the same interface. Repo
 * logic never names a concrete remote — it only ever sees this contract.
 *
 * The credential invariant. This library **never** stores a credential. A
 * caller supplies one per request through {@link CredentialHook}; the adapter
 * calls the hook at request time, uses the returned value in memory for that one
 * request, and discards it. A credential is never written to IndexedDB, repo
 * data, config, an export, a commit, a remote URL, or a log, and is redacted
 * from any error this module throws. See {@link CredentialHook}.
 */

import type { PromiseFs } from '../fs-backend.js';

/**
 * The git `fs` shape a sync target drives (its `.promises` is a {@link PromiseFs}).
 * This is the same object the core passes to isomorphic-git; a sync target reads
 * and writes the repo's `.git` through it, never through app state.
 */
export type SyncFs = { promises: PromiseFs };

/**
 * A credential a {@link CredentialHook} may return for one request.
 *
 * For GitHub over HTTPS the usual shape is `{ username: '<user or token>',
 * password: '<personal-access-token>' }`, or a bearer token via
 * `{ headers: { Authorization: 'Bearer <token>' } }`. Whatever is returned is
 * used **only** for the single in-flight request and then dropped; the library
 * keeps no reference to it.
 */
export interface SyncCredentials {
  /** Username (or a token used as the username for token auth). */
  username?: string;
  /** Password or personal-access-token. */
  password?: string;
  /** Extra request headers, e.g. `{ Authorization: 'Bearer …' }`. */
  headers?: Record<string, string>;
}

/**
 * Context handed to a {@link CredentialHook} so it can decide what to return.
 * Carries only non-secret request facts — never a credential.
 */
export interface CredentialRequest {
  /** The remote URL the request is going to (no embedded credential). */
  url: string;
  /** The operation that needs the credential. */
  operation: 'push' | 'pull' | 'clone';
}

/**
 * The caller-supplied hook that provides a credential **per request**.
 *
 * This is the only channel through which a credential enters the library. The
 * adapter calls it immediately before a network request, uses the result for
 * that request alone, and discards it — it is never persisted anywhere. Return
 * `undefined` (or nothing) to attempt the request unauthenticated; for a remote
 * that requires auth, that surfaces as an {@link import('../errors.js').AuthError}.
 *
 * The hook may be async (e.g. to read a token the caller holds in memory, or to
 * prompt the user). It must not expect the library to remember what it returns.
 */
export type CredentialHook = (
  request: CredentialRequest,
) => SyncCredentials | undefined | Promise<SyncCredentials | undefined>;

/** Options common to every {@link RemoteSyncTarget} operation. */
export interface SyncOptions {
  /**
   * Per-request credential hook. Omit for an unauthenticated request (public
   * read over HTTPS). The library calls it at request time and never stores the
   * returned value. See {@link CredentialHook}.
   */
  getCredentials?: CredentialHook;
  /** Abort the in-flight request. */
  signal?: AbortSignal;
}

/** Options for {@link RemoteSyncTarget.push}. */
export interface PushOptions extends SyncOptions {
  /** Local branch to push. Defaults to the repo's current branch. */
  ref?: string;
  /** Remote branch to update. Defaults to `ref`. */
  remoteRef?: string;
  /**
   * Force-update the remote ref even when it is not a fast-forward. Off by
   * default — a non-fast-forward push surfaces as a
   * {@link import('../errors.js').DivergenceError} instead of silently
   * overwriting remote history.
   */
  force?: boolean;
}

/** Options for {@link RemoteSyncTarget.pull}. */
export interface PullOptions extends SyncOptions {
  /** Local branch to update. Defaults to the repo's current branch. */
  ref?: string;
  /** Remote branch to pull from. Defaults to `ref`. */
  remoteRef?: string;
  /**
   * Only fast-forward; refuse a merge. On when omitted, so a pull that would
   * need a merge surfaces as a {@link import('../errors.js').DivergenceError}
   * rather than creating a merge commit the caller did not ask for.
   */
  fastForwardOnly?: boolean;
  /**
   * Author recorded on a merge commit, if the pull creates one. Plain commit
   * metadata — never a credential.
   */
  author?: { name: string; email: string };
}

/** Options for {@link RemoteSyncTarget.clone}. */
export interface CloneOptions extends SyncOptions {
  /** Single branch to clone. Clones the remote's default branch when omitted. */
  ref?: string;
  /** Shallow-clone depth. Omit for the full history. */
  depth?: number;
}

/** The outcome of a successful {@link RemoteSyncTarget.push}. */
export interface PushOutcome {
  /** True when the remote accepted every ref update. */
  ok: boolean;
  /** The refs the push updated, mapped to the remote's per-ref status. */
  refs: Record<string, { ok: boolean; error?: string }>;
}

/**
 * The pluggable contract for syncing one repository's git data to and from a
 * remote. An implementation is bound to a single remote URL (its constructor's
 * job). All three methods drive the repo's `.git` through the supplied
 * {@link SyncFs} and never touch app state.
 *
 * Every method maps a remote failure onto the library's typed error family
 * ({@link import('../errors.js').NetworkError},
 * {@link import('../errors.js').CorsError},
 * {@link import('../errors.js').AuthError},
 * {@link import('../errors.js').DivergenceError},
 * {@link import('../errors.js').ConflictError}), each distinct and catchable,
 * with any credential redacted from the message.
 */
export interface RemoteSyncTarget {
  /**
   * Push a local branch's commits to the remote. Refuses a non-fast-forward
   * update (surfaced as a `DivergenceError`) unless `force` is set.
   */
  push(fs: SyncFs, dir: string, options?: PushOptions): Promise<PushOutcome>;

  /**
   * Pull the remote branch into the working tree. Fast-forward only by default;
   * a pull that would diverge surfaces as a `DivergenceError`, and overlapping
   * edits as a `ConflictError`.
   */
  pull(fs: SyncFs, dir: string, options?: PullOptions): Promise<void>;

  /**
   * Clone the remote into a fresh working tree at `dir`. The `dir` must be an
   * empty, initialized working directory inside the repo's namespace.
   */
  clone(fs: SyncFs, dir: string, options?: CloneOptions): Promise<void>;
}
