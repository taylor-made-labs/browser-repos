/**
 * A single open repository.
 *
 * Wraps an IndexedDB-backed {@link FsBackend} and an isomorphic-git working
 * directory. Slice 1 covers the repository lifecycle and file operations:
 * write, read, list, delete, and `exists`. Staging, commits, branches, history,
 * and sync arrive in later slices behind this same surface.
 *
 * All file operations are repo-relative and path-validated; paths that try to
 * escape the working tree are rejected before they ever reach the filesystem.
 */

import git from 'isomorphic-git';
import type { FsBackend } from './fs-backend.js';
import { NotFoundError, QuotaExceededError, StorageError } from './errors.js';
import { classifyStorageError, MutationQueue } from './durability.js';
import { normalizeRelPath, toFsPath } from './path.js';
import { GitOps } from './git-ops.js';
import type {
  CommitEntry,
  CommitOptions,
  FileStatus,
  LogOptions,
  StatusReport,
} from './git-ops.js';
import { BranchOps } from './branch-ops.js';
import type { CreateBranchOptions } from './branch-ops.js';
import { exportRepo } from './export-import.js';

/** Absolute working-tree root inside the per-repo filesystem namespace. */
const WORK_DIR = '/work';

/** An entry returned by {@link BrowserRepo.listFiles}. */
export interface DirEntry {
  /** Entry name (not a path), e.g. `README.md`. */
  name: string;
  /** Whether the entry is a directory. */
  isDirectory: boolean;
}

/**
 * The lock-free mutating steps available inside a {@link BrowserRepo.runExclusive}
 * callback. Same semantics as the matching {@link BrowserRepo} methods, but they
 * do not re-take the repo lock (the enclosing `runExclusive` already holds it),
 * so a multi-step mutation composes as one atomic unit.
 */
export interface RepoTransaction {
  /** Write a repo-relative file (creates parent dirs). */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** Stage a file (`git add`). */
  stage(path: string): Promise<void>;
  /** Stage the removal of a tracked file. */
  stageRemoval(path: string): Promise<void>;
  /** Unstage a path. */
  unstage(path: string): Promise<void>;
  /** Commit the current index; returns the new oid. */
  commit(options: CommitOptions): Promise<string>;
  /** Create a branch (optionally checking it out). */
  createBranch(name: string, options?: CreateBranchOptions): Promise<void>;
  /** Switch to an existing branch. */
  checkout(name: string): Promise<void>;
  /** Delete a local branch. */
  deleteBranch(name: string): Promise<void>;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Handle to an initialized repository. Obtained from the repo manager
 * (`create` or `open`); do not construct directly.
 */
export class BrowserRepo {
  /** Stable repository id. */
  readonly id: string;
  /** The IndexedDB namespace backing this repo. */
  readonly namespace: string;

  private readonly backend: FsBackend;
  private readonly git: GitOps;
  private readonly branches: BranchOps;
  /**
   * Per-repo mutation lock. Every mutating method runs through it so two
   * conflicting mutations on this repo serialize instead of racing on the
   * shared `.git` index/refs. The manager injects a queue shared by all handles
   * to the same repo id; absent one (direct construction in a test), a private
   * queue is used so the handle is still internally consistent.
   */
  private readonly mutations: MutationQueue;

  /** @internal — constructed by the repo manager. */
  constructor(id: string, backend: FsBackend, mutations?: MutationQueue) {
    this.id = id;
    this.namespace = backend.namespace;
    this.backend = backend;
    this.git = new GitOps(backend.fs, WORK_DIR);
    this.branches = new BranchOps(backend.fs, WORK_DIR);
    this.mutations = mutations ?? new MutationQueue();
  }

  /**
   * Run a mutation under this repo's serialization lock. Conflicting mutations
   * queue and run one at a time in submission order, so the final state is the
   * consistent sequential result rather than a corrupt or lost-update
   * interleaving. Read-only methods deliberately do not take the lock.
   * @internal
   */
  private runMutation<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutations.run(fn);
  }

  /**
   * Run a multi-step mutation as ONE serialized unit, holding this repo's lock
   * for the whole callback.
   *
   * Each individual mutating method (`writeFile`, `stage`, `commit`, …) already
   * serializes on its own, which prevents index corruption. But a *sequence*
   * like "write → stage → commit" can still interleave with another sequence
   * between its steps: two such sequences racing can leave one commit finding
   * nothing newly staged. Wrapping the whole sequence in `runExclusive` makes it
   * atomic with respect to this repo's other mutations, so overlapping
   * "write-stage-commit" cycles each land as a clean, separate commit.
   *
   * Reentrancy note: the callback must NOT call another `runExclusive` or a
   * mutating method on the same repo (that would wait on the lock this call
   * already holds and deadlock). Use the explicit {@link GitOps}-style steps via
   * the handle passed to the callback instead — or, more simply, perform the
   * raw library work through a nested-safe path. In practice callers compose the
   * public read methods plus the private steps the library exposes to the
   * callback.
   */
  async runExclusive<T>(fn: (tx: RepoTransaction) => Promise<T>): Promise<T> {
    return this.mutations.run(() => fn(this.txApi));
  }

  /**
   * The lock-free step API handed to a {@link runExclusive} callback. Its
   * methods perform the same work as the public mutators but WITHOUT re-taking
   * the lock (the surrounding `runExclusive` already holds it), so they compose
   * inside one atomic unit without deadlocking.
   */
  private get txApi(): RepoTransaction {
    return {
      writeFile: async (path, data) => {
        const rel = normalizeRelPath(path);
        const abs = toFsPath(WORK_DIR, rel);
        await this.ensureParentDirs(rel);
        try {
          if (typeof data === 'string') {
            await this.backend.promises.writeFile(abs, data, 'utf8');
          } else {
            await this.backend.promises.writeFile(abs, data);
          }
        } catch (err) {
          throw toWriteError(`Failed to write file "${rel}".`, err);
        }
      },
      stage: (path) => this.git.stage(path),
      stageRemoval: (path) => this.git.stageRemoval(path),
      unstage: (path) => this.git.unstage(path),
      commit: (options) => this.git.commit(options),
      createBranch: (name, options) => this.branches.createBranch(name, options),
      checkout: (name) => this.branches.checkout(name),
      deleteBranch: (name) => this.branches.deleteBranch(name),
    };
  }

  /**
   * Initialize the git working tree for this repo if it is not already a repo.
   * Idempotent: safe to call on every open.
   * @internal
   */
  async ensureInitialized(): Promise<void> {
    const { promises } = this.backend;
    try {
      await promises.mkdir(WORK_DIR);
    } catch (err) {
      // Directory already exists is fine; anything else is a storage fault.
      if (!isEexist(err)) {
        throw new StorageError(`Failed to create working directory for "${this.id}".`, err);
      }
    }
    // `git.init` is idempotent — it re-initializes without destroying content.
    try {
      await git.init({ fs: this.backend.fs, dir: WORK_DIR, defaultBranch: 'main' });
    } catch (err) {
      throw new StorageError(`Failed to initialize git repo "${this.id}".`, err);
    }
  }

  /**
   * Write a UTF-8 or binary file at a repo-relative path, creating parent dirs.
   * Serialized against this repo's other mutations. A quota-exceeded failure is
   * surfaced as a distinct {@link QuotaExceededError}, not a generic one.
   */
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const rel = normalizeRelPath(path);
    const abs = toFsPath(WORK_DIR, rel);
    return this.runMutation(async () => {
      await this.ensureParentDirs(rel);
      try {
        if (typeof data === 'string') {
          await this.backend.promises.writeFile(abs, data, 'utf8');
        } else {
          await this.backend.promises.writeFile(abs, data);
        }
      } catch (err) {
        throw toWriteError(`Failed to write file "${rel}".`, err);
      }
    });
  }

  /** Read a file as a UTF-8 string. Throws {@link NotFoundError} if absent. */
  async readFile(path: string): Promise<string> {
    const rel = normalizeRelPath(path);
    const abs = toFsPath(WORK_DIR, rel);
    try {
      const out = await this.backend.promises.readFile(abs, 'utf8');
      return typeof out === 'string' ? out : new TextDecoder().decode(out);
    } catch (err) {
      if (isEnoent(err)) throw new NotFoundError(rel);
      throw new StorageError(`Failed to read file "${rel}".`, err);
    }
  }

  /** Read a file as raw bytes. Throws {@link NotFoundError} if absent. */
  async readFileBytes(path: string): Promise<Uint8Array> {
    const rel = normalizeRelPath(path);
    const abs = toFsPath(WORK_DIR, rel);
    try {
      const out = await this.backend.promises.readFile(abs);
      return typeof out === 'string' ? new TextEncoder().encode(out) : out;
    } catch (err) {
      if (isEnoent(err)) throw new NotFoundError(rel);
      throw new StorageError(`Failed to read file "${rel}".`, err);
    }
  }

  /** Whether a repo-relative path exists (file or directory). */
  async exists(path: string): Promise<boolean> {
    const rel = normalizeRelPath(path);
    const abs = toFsPath(WORK_DIR, rel);
    try {
      await this.backend.promises.stat(abs);
      return true;
    } catch (err) {
      if (isEnoent(err)) return false;
      throw new StorageError(`Failed to stat "${rel}".`, err);
    }
  }

  /**
   * List the entries of a directory. Pass no argument (or `'.'`) for the repo
   * root. The `.git` directory is hidden from listings.
   */
  async listFiles(path = '.'): Promise<DirEntry[]> {
    const abs = path === '.' || path.trim() === '' ? WORK_DIR : toFsPath(WORK_DIR, path);
    let names: string[];
    try {
      names = await this.backend.promises.readdir(abs);
    } catch (err) {
      if (isEnoent(err)) throw new NotFoundError(path);
      throw new StorageError(`Failed to list directory "${path}".`, err);
    }
    const entries: DirEntry[] = [];
    for (const name of names) {
      if (name === '.git') continue;
      const childAbs = `${abs}/${name}`;
      let isDirectory = false;
      try {
        const st = await this.backend.promises.stat(childAbs);
        isDirectory = st.isDirectory();
      } catch {
        // Race or dangling entry: report as a file rather than failing the list.
        isDirectory = false;
      }
      entries.push({ name, isDirectory });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  /** Delete a file at a repo-relative path. Throws {@link NotFoundError} if absent. */
  async deleteFile(path: string): Promise<void> {
    const rel = normalizeRelPath(path);
    const abs = toFsPath(WORK_DIR, rel);
    return this.runMutation(async () => {
      try {
        await this.backend.promises.unlink(abs);
      } catch (err) {
        if (isEnoent(err)) throw new NotFoundError(rel);
        throw toWriteError(`Failed to delete file "${rel}".`, err);
      }
    });
  }

  // ---- Git operations (slice 2): offline status, staging, commit, history ----

  /**
   * Report the working-tree status of the whole repo: every path differing from
   * HEAD (sorted), plus a `clean` flag. See {@link StatusReport}.
   */
  async status(): Promise<StatusReport> {
    return this.git.status();
  }

  /** Status of a single repo-relative path. See {@link FileStatus}. */
  async statusOf(path: string): Promise<FileStatus> {
    return this.git.statusOf(path);
  }

  /** Stage a file (`git add`). Path is validated against traversal. Serialized. */
  async stage(path: string): Promise<void> {
    return this.runMutation(() => this.git.stage(path));
  }

  /** Stage the removal of a tracked file from the index (`git rm --cached`). Serialized. */
  async stageRemoval(path: string): Promise<void> {
    return this.runMutation(() => this.git.stageRemoval(path));
  }

  /** Unstage a path, returning its index entry to HEAD (`git reset <path>`). Serialized. */
  async unstage(path: string): Promise<void> {
    return this.runMutation(() => this.git.unstage(path));
  }

  /**
   * Commit the current index. Author is plain commit metadata supplied by the
   * caller (never a credential). Throws {@link NothingStagedError} if nothing is
   * staged. Returns the new commit oid.
   *
   * Serialized against this repo's other mutations: two overlapping commit
   * cycles would otherwise race on the shared index and silently drop one
   * commit; the queue makes them land one after the other.
   */
  async commit(options: CommitOptions): Promise<string> {
    return this.runMutation(() => this.git.commit(options));
  }

  /** List commits newest-first, optionally limited by `depth`. */
  async log(options?: LogOptions): Promise<CommitEntry[]> {
    return this.git.log(options);
  }

  // ---- Branches + checkout (slice 3): local, offline branching ----

  /** The name of the branch HEAD currently points at (e.g. `main`). */
  async currentBranch(): Promise<string> {
    return this.branches.currentBranch();
  }

  /** List local branch names, sorted. */
  async listBranches(): Promise<string[]> {
    return this.branches.listBranches();
  }

  /** Whether a local branch with the given (validated) name exists. */
  async hasBranch(name: string): Promise<boolean> {
    return this.branches.hasBranch(name);
  }

  /**
   * Create a branch at the current HEAD (or at `options.from`). HEAD is not
   * moved unless `options.checkout` is true. See {@link BranchOps.createBranch}.
   */
  async createBranch(name: string, options?: CreateBranchOptions): Promise<void> {
    return this.runMutation(() => this.branches.createBranch(name, options));
  }

  /**
   * Switch to an existing branch: move HEAD and rewrite the working tree to
   * match. Refuses to run with uncommitted changes to tracked files. See
   * {@link BranchOps.checkout}. Serialized, so a checkout never interleaves
   * with a concurrent write/commit mid-tree-rewrite.
   */
  async checkout(name: string): Promise<void> {
    return this.runMutation(() => this.branches.checkout(name));
  }

  /**
   * Delete a local branch. Throws for a nonexistent branch or the current one.
   * See {@link BranchOps.deleteBranch}. Serialized.
   */
  async deleteBranch(name: string): Promise<void> {
    return this.runMutation(() => this.branches.deleteBranch(name));
  }

  // ---- Lossless export / import (slice 4): the round-trip slice ----

  /**
   * Export the entire repository as a single portable archive: the working
   * tree, the complete `.git` (all objects, refs, every branch, full history),
   * the index/staged state, and untracked files — all byte-exact. Reconstruct
   * it with {@link RepoManager.importRepo}.
   *
   * The archive is credential-free by construction: the library never writes a
   * credential to repo data, so none can appear in it.
   */
  async export(): Promise<Uint8Array> {
    return exportRepo(this.backend.fs, WORK_DIR);
  }

  /** Resolves once every queued mutation on this repo has settled. @internal */
  async drainMutations(): Promise<void> {
    return this.mutations.drain();
  }

  /** The repo's filesystem backend. @internal — used by the repo manager. */
  get fsBackend(): FsBackend {
    return this.backend;
  }

  /** The absolute working-tree root inside this repo's namespace. @internal */
  get workDir(): string {
    return WORK_DIR;
  }

  /** Create every missing parent directory for a repo-relative file path. */
  private async ensureParentDirs(relPath: string): Promise<void> {
    const parts = relPath.split('/');
    parts.pop(); // drop the file name
    let cur = WORK_DIR;
    for (const part of parts) {
      cur = `${cur}/${part}`;
      try {
        await this.backend.promises.mkdir(cur);
      } catch (err) {
        if (!isEexist(err)) {
          throw new StorageError(`Failed to create directory "${cur}".`, err);
        }
      }
    }
  }
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'EEXIST'
  );
}

/**
 * Map a raw write failure onto a typed error, keeping a storage-quota overflow
 * distinct from a generic storage fault so callers can branch on `code`.
 */
function toWriteError(context: string, err: unknown): Error {
  if (classifyStorageError(err) === 'quota') {
    return new QuotaExceededError(`${context} The browser storage quota was exceeded.`, err);
  }
  return new StorageError(context, err);
}
