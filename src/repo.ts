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

  /** @internal — constructed by the repo manager. */
  constructor(id: string, backend: FsBackend) {
    this.id = id;
    this.namespace = backend.namespace;
    this.backend = backend;
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
