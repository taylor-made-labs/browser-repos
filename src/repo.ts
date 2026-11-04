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
import { NotFoundError, StorageError } from './errors.js';
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

  /** @internal — constructed by the repo manager. */
  constructor(id: string, backend: FsBackend) {
    this.id = id;
    this.namespace = backend.namespace;
    this.backend = backend;
    this.git = new GitOps(backend.fs, WORK_DIR);
    this.branches = new BranchOps(backend.fs, WORK_DIR);
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

  /** Write a UTF-8 or binary file at a repo-relative path, creating parent dirs. */
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
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
      throw new StorageError(`Failed to write file "${rel}".`, err);
    }
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
    try {
      await this.backend.promises.unlink(abs);
    } catch (err) {
      if (isEnoent(err)) throw new NotFoundError(rel);
      throw new StorageError(`Failed to delete file "${rel}".`, err);
    }
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

  /** Stage a file (`git add`). Path is validated against traversal. */
  async stage(path: string): Promise<void> {
    return this.git.stage(path);
  }

  /** Stage the removal of a tracked file from the index (`git rm --cached`). */
  async stageRemoval(path: string): Promise<void> {
    return this.git.stageRemoval(path);
  }

  /** Unstage a path, returning its index entry to HEAD (`git reset <path>`). */
  async unstage(path: string): Promise<void> {
    return this.git.unstage(path);
  }

  /**
   * Commit the current index. Author is plain commit metadata supplied by the
   * caller (never a credential). Throws {@link NothingStagedError} if nothing is
   * staged. Returns the new commit oid.
   */
  async commit(options: CommitOptions): Promise<string> {
    return this.git.commit(options);
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
    return this.branches.createBranch(name, options);
  }

  /**
   * Switch to an existing branch: move HEAD and rewrite the working tree to
   * match. Refuses to run with uncommitted changes to tracked files. See
   * {@link BranchOps.checkout}.
   */
  async checkout(name: string): Promise<void> {
    return this.branches.checkout(name);
  }

  /**
   * Delete a local branch. Throws for a nonexistent branch or the current one.
   * See {@link BranchOps.deleteBranch}.
   */
  async deleteBranch(name: string): Promise<void> {
    return this.branches.deleteBranch(name);
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
