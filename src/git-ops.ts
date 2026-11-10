/**
 * Offline git operations for a {@link BrowserRepo}.
 *
 * Slice 2 adds the local, offline half of git on top of slice 1's repository
 * lifecycle: working-tree status, staging (add / unstage), commits, and the
 * commit log. Everything here runs against the per-repo IndexedDB-backed
 * filesystem through isomorphic-git — there is no network, no clone, no push,
 * and no fetch in this slice.
 *
 * These functions are pure library logic: they are wired onto {@link BrowserRepo}
 * as methods, but take the filesystem handle and working directory explicitly so
 * the behavior is easy to reason about and test. Author identity is plain commit
 * metadata supplied by the caller — this library never reads, stores, or asks
 * for any credential.
 */

import './buffer-polyfill.js';
import git from 'isomorphic-git';
import type { PromiseFs } from './fs-backend.js';
import { NothingStagedError, StorageError } from './errors.js';
import { normalizeRelPath } from './path.js';

/** The isomorphic-git `fs` shape (its `.promises` is a {@link PromiseFs}). */
type GitFs = { promises: PromiseFs };

/**
 * The state of a single path in the working tree, derived from isomorphic-git's
 * status matrix. Each value names a concrete, human-meaningful condition:
 *
 * - `unmodified` — tracked and identical in HEAD, index, and working tree.
 * - `untracked` — present in the working tree, absent from HEAD and the index.
 * - `modified` — tracked, changed in the working tree, not yet staged.
 * - `staged` — a new or modified file whose current content is staged.
 * - `deleted` — tracked in HEAD but removed from the working tree, not staged.
 * - `staged-deletion` — a deletion that has been staged (removed from index).
 */
export type FileStatus =
  | 'unmodified'
  | 'untracked'
  | 'modified'
  | 'staged'
  | 'deleted'
  | 'staged-deletion';

/** One entry in a {@link StatusReport}: a repo-relative path and its state. */
export interface FileStatusEntry {
  /** Repo-relative, forward-slash path. */
  path: string;
  /** The derived working-tree / index status for this path. */
  status: FileStatus;
}

/**
 * A snapshot of the working tree. `files` lists every path that is not
 * `unmodified`, sorted by path; `clean` is true when nothing differs from HEAD.
 */
export interface StatusReport {
  /** True when HEAD, index, and working tree all agree (nothing to commit). */
  clean: boolean;
  /** Non-`unmodified` paths, sorted by path. */
  files: FileStatusEntry[];
}

/** Commit author / committer identity. Plain metadata — never a credential. */
export interface CommitAuthor {
  /** Display name recorded on the commit, e.g. `Ada Lovelace`. */
  name: string;
  /** Email recorded on the commit, e.g. `ada@example.com`. */
  email: string;
}

/** Arguments for {@link GitOps.commit}. */
export interface CommitOptions {
  /** The commit message. */
  message: string;
  /** Author identity (also used as committer unless `committer` is given). */
  author: CommitAuthor;
  /** Optional committer identity; defaults to `author`. */
  committer?: CommitAuthor;
}

/** One entry returned by {@link GitOps.log}, newest-first. */
export interface CommitEntry {
  /** The commit's object id (full SHA-1 hex). */
  oid: string;
  /** The commit message, verbatim. */
  message: string;
  /** The recorded author identity. */
  author: CommitAuthor;
  /** Author timestamp in Unix seconds. */
  timestamp: number;
  /** Parent commit oids (empty for the root commit). */
  parents: string[];
}

/** Options for {@link GitOps.log}. */
export interface LogOptions {
  /** Maximum number of commits to return. Omit for the full history. */
  depth?: number;
}

// Status-matrix column indices, per isomorphic-git's `statusMatrix` contract:
// row = [filepath, HEAD, WORKDIR, STAGE]. 0 = absent; HEAD 1 = present;
// WORKDIR 1 = same as HEAD, 2 = changed; STAGE 1 = same as HEAD, 2 = changed,
// 3 = changed again after staging.
const HEAD = 1;
const WORKDIR = 2;
const STAGE = 3;

/**
 * Map one status-matrix row to a {@link FileStatus}. Kept total and explicit so
 * every combination isomorphic-git can emit lands on a named state rather than
 * a silent default.
 */
function rowToStatus(head: number, workdir: number, stage: number): FileStatus {
  // Absent from HEAD.
  if (head === 0) {
    if (workdir === 0) {
      // Added to the index then removed from disk — treat as untracked noise.
      return 'untracked';
    }
    // New file on disk: staged if the index already has it, else untracked.
    return stage === 0 ? 'untracked' : 'staged';
  }
  // Present in HEAD but gone from the working tree: a deletion.
  if (workdir === 0) {
    return stage === 0 ? 'staged-deletion' : 'deleted';
  }
  // Tracked and present. Compare working tree and index against HEAD.
  if (workdir === 1 && stage === 1) {
    return 'unmodified';
  }
  if (stage === 1) {
    // Index matches HEAD but the working tree changed: unstaged modification.
    return 'modified';
  }
  if (workdir === stage) {
    // Working tree and index agree and both differ from HEAD: fully staged.
    return 'staged';
  }
  // Staged a change, then edited the file again: staged + further unstaged work.
  return 'modified';
}

/**
 * The offline git operations, bound to one repository's filesystem and working
 * directory. Instances are created internally by {@link BrowserRepo}.
 */
export class GitOps {
  private readonly fs: GitFs;
  private readonly dir: string;

  /** @internal — constructed by {@link BrowserRepo}. */
  constructor(fs: GitFs, dir: string) {
    this.fs = fs;
    this.dir = dir;
  }

  /**
   * Report the working-tree status of the whole repo. Returns every path that
   * differs from HEAD, sorted by path, plus a `clean` flag.
   */
  async status(): Promise<StatusReport> {
    let matrix: Array<[string, number, number, number]>;
    try {
      matrix = (await git.statusMatrix({ fs: this.fs, dir: this.dir })) as Array<
        [string, number, number, number]
      >;
    } catch (err) {
      throw new StorageError('Failed to read working-tree status.', err);
    }
    const files: FileStatusEntry[] = [];
    for (const row of matrix) {
      const path = row[0];
      const status = rowToStatus(row[HEAD], row[WORKDIR], row[STAGE]);
      if (status !== 'unmodified') {
        files.push({ path, status });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { clean: files.length === 0, files };
  }

  /**
   * Status of a single repo-relative path. Returns `unmodified` for a tracked,
   * unchanged file and `untracked` for one git has never seen.
   */
  async statusOf(path: string): Promise<FileStatus> {
    const rel = normalizeRelPath(path);
    try {
      const matrix = (await git.statusMatrix({
        fs: this.fs,
        dir: this.dir,
        filepaths: [rel],
      })) as Array<[string, number, number, number]>;
      const row = matrix.find((r) => r[0] === rel);
      if (!row) return 'untracked';
      return rowToStatus(row[HEAD], row[WORKDIR], row[STAGE]);
    } catch (err) {
      throw new StorageError(`Failed to read status for "${rel}".`, err);
    }
  }

  /** Stage a file (equivalent to `git add <path>`). Path is validated. */
  async stage(path: string): Promise<void> {
    const rel = normalizeRelPath(path);
    try {
      await git.add({ fs: this.fs, dir: this.dir, filepath: rel });
    } catch (err) {
      throw new StorageError(`Failed to stage "${rel}".`, err);
    }
  }

  /**
   * Stage the removal of a tracked file (`git rm --cached` + delete-from-index
   * semantics for the index side). The working-tree file, if present, is left
   * untouched; this stages the deletion in the index.
   */
  async stageRemoval(path: string): Promise<void> {
    const rel = normalizeRelPath(path);
    try {
      await git.remove({ fs: this.fs, dir: this.dir, filepath: rel });
    } catch (err) {
      throw new StorageError(`Failed to stage removal of "${rel}".`, err);
    }
  }

  /**
   * Unstage a path, returning the index entry to match HEAD (`git reset <path>`).
   * A file staged for the first time returns to untracked; a staged edit to a
   * tracked file returns to modified/unmodified per the working tree.
   */
  async unstage(path: string): Promise<void> {
    const rel = normalizeRelPath(path);
    try {
      await git.resetIndex({ fs: this.fs, dir: this.dir, filepath: rel });
    } catch (err) {
      throw new StorageError(`Failed to unstage "${rel}".`, err);
    }
  }

  /**
   * Create a commit from the current index.
   *
   * @throws {NothingStagedError} when the index holds no changes relative to
   *   HEAD — the chosen, tested behavior for an empty commit rather than a
   *   silent no-op.
   * @returns the new commit's oid.
   */
  async commit(options: CommitOptions): Promise<string> {
    const { clean } = await this.status();
    const staged = await this.hasStagedChanges();
    if (clean || !staged) {
      throw new NothingStagedError();
    }
    const committer = options.committer ?? options.author;
    try {
      return await git.commit({
        fs: this.fs,
        dir: this.dir,
        message: options.message,
        author: { name: options.author.name, email: options.author.email },
        committer: { name: committer.name, email: committer.email },
      });
    } catch (err) {
      throw new StorageError('Failed to create commit.', err);
    }
  }

  /**
   * List commits newest-first. With `depth`, returns at most that many of the
   * most recent commits. On a repo with no commits yet, returns an empty list.
   */
  async log(options: LogOptions = {}): Promise<CommitEntry[]> {
    let entries: Awaited<ReturnType<typeof git.log>>;
    try {
      entries = await git.log(
        options.depth === undefined
          ? { fs: this.fs, dir: this.dir }
          : { fs: this.fs, dir: this.dir, depth: options.depth },
      );
    } catch (err) {
      // An unborn branch (no commits yet) surfaces as a NotFound on HEAD.
      if (isUnbornBranch(err)) return [];
      throw new StorageError('Failed to read commit history.', err);
    }
    return entries.map((e) => ({
      oid: e.oid,
      message: e.commit.message,
      author: { name: e.commit.author.name, email: e.commit.author.email },
      timestamp: e.commit.author.timestamp,
      parents: e.commit.parent,
    }));
  }

  /** True when the index differs from HEAD (there is something to commit). */
  private async hasStagedChanges(): Promise<boolean> {
    const matrix = (await git.statusMatrix({ fs: this.fs, dir: this.dir })) as Array<
      [string, number, number, number]
    >;
    for (const row of matrix) {
      const head = row[HEAD];
      const stage = row[STAGE];
      // Staged add/modify: HEAD absent but staged, or HEAD present and stage != 1.
      if (head === 0 && stage !== 0) return true;
      if (head === 1 && stage !== 1) return true;
    }
    return false;
  }
}

/** Whether an error is isomorphic-git's "no commits yet" / unborn-HEAD signal. */
function isUnbornBranch(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const name = (err as { name?: unknown }).name;
  return (
    code === 'NotFoundError' ||
    name === 'NotFoundError' ||
    code === 'ResolveRefError' ||
    name === 'ResolveRefError'
  );
}
