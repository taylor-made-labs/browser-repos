/**
 * Manager for multiple independent repositories in one browser.
 *
 * Each repo lives in its own IndexedDB namespace (so repos never collide), and
 * the set of known repo ids is persisted in a separate registry namespace as a
 * JSON manifest — so the repo list, like the repos themselves, survives close
 * and reopen.
 *
 * Everything here is local and offline: no network, no server, no credentials.
 */

import type { FsBackend, FsBackendFactory } from './fs-backend.js';
import { lightningFsBackendFactory } from './fs-backend.js';
import { BrowserRepo } from './repo.js';
import {
  InvalidRepoIdError,
  RepoExistsError,
  RepoNotFoundError,
  StorageError,
} from './errors.js';

/** Prefix applied to every repo's IndexedDB namespace, keeping them grouped. */
const REPO_NS_PREFIX = 'browser-repos:repo:';
/** Dedicated namespace holding the registry manifest. */
const REGISTRY_NS = 'browser-repos:registry';
/** Path of the manifest file inside the registry namespace. */
const MANIFEST_PATH = '/repos.json';

/** Valid repo id: 1–128 chars of letters, digits, `-`, `_`, `.` (no `..`). */
const REPO_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Options for constructing a {@link RepoManager}. */
export interface RepoManagerOptions {
  /**
   * Backend factory. Defaults to the IndexedDB-backed LightningFS factory.
   * Injectable so durability tests can drive a swappable store.
   */
  backendFactory?: FsBackendFactory;
}

/** Metadata for a known repository. */
export interface RepoInfo {
  /** Stable repository id. */
  id: string;
  /** IndexedDB namespace backing the repo. */
  namespace: string;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function assertValidRepoId(id: string): void {
  if (typeof id !== 'string' || !REPO_ID_RE.test(id) || id.includes('..')) {
    throw new InvalidRepoIdError(
      `Invalid repository id "${String(id)}": use 1–128 chars of letters, digits, '-', '_', '.' and no "..".`,
    );
  }
}

/**
 * Create and manage multiple repositories. Construct one per application; it
 * holds no per-repo state beyond the injected backend factory, so it is cheap.
 */
export class RepoManager {
  private readonly backendFactory: FsBackendFactory;
  private readonly registry: FsBackend;

  constructor(options: RepoManagerOptions = {}) {
    this.backendFactory = options.backendFactory ?? lightningFsBackendFactory;
    this.registry = this.backendFactory(REGISTRY_NS);
  }

  /** Namespace used for a repo id. */
  private nsFor(id: string): string {
    return `${REPO_NS_PREFIX}${id}`;
  }

  /** Read the persisted registry manifest (ids of known repos). */
  private async readManifest(): Promise<string[]> {
    try {
      const raw = await this.registry.promises.readFile(MANIFEST_PATH, 'utf8');
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x): x is string => typeof x === 'string');
    } catch (err) {
      if (isEnoent(err)) return [];
      throw new StorageError('Failed to read the repository registry.', err);
    }
  }

  /** Persist the registry manifest. */
  private async writeManifest(ids: string[]): Promise<void> {
    const unique = Array.from(new Set(ids)).sort();
    try {
      await this.registry.promises.writeFile(MANIFEST_PATH, JSON.stringify(unique), 'utf8');
    } catch (err) {
      throw new StorageError('Failed to persist the repository registry.', err);
    }
  }

  /** List all known repositories (persisted across reopen). */
  async listRepos(): Promise<RepoInfo[]> {
    const ids = await this.readManifest();
    return ids.map((id) => ({ id, namespace: this.nsFor(id) }));
  }

  /** Whether a repository with the given id exists. */
  async hasRepo(id: string): Promise<boolean> {
    assertValidRepoId(id);
    const ids = await this.readManifest();
    return ids.includes(id);
  }

  /**
   * Create a new, empty repository and initialize its git working tree.
   * @throws {InvalidRepoIdError} if the id is malformed.
   * @throws {RepoExistsError} if a repo with that id already exists.
   */
  async createRepo(id: string): Promise<BrowserRepo> {
    assertValidRepoId(id);
    const ids = await this.readManifest();
    if (ids.includes(id)) {
      throw new RepoExistsError(id);
    }
    const backend = this.backendFactory(this.nsFor(id));
    const repo = new BrowserRepo(id, backend);
    await repo.ensureInitialized();
    await this.writeManifest([...ids, id]);
    return repo;
  }

  /**
   * Open an existing repository.
   * @throws {InvalidRepoIdError} if the id is malformed.
   * @throws {RepoNotFoundError} if no repo with that id exists.
   */
  async openRepo(id: string): Promise<BrowserRepo> {
    assertValidRepoId(id);
    const ids = await this.readManifest();
    if (!ids.includes(id)) {
      throw new RepoNotFoundError(id);
    }
    const backend = this.backendFactory(this.nsFor(id));
    const repo = new BrowserRepo(id, backend);
    // Re-ensure init so a fresh handle after reopen has a usable working tree;
    // git.init is idempotent and does not destroy existing content.
    await repo.ensureInitialized();
    return repo;
  }

  /**
   * Delete a repository: remove it from the registry and wipe its working-tree
   * contents. The IndexedDB namespace itself is emptied of files; later slices
   * may add full database-drop once export/import guarantees recovery.
   * @throws {RepoNotFoundError} if no repo with that id exists.
   */
  async deleteRepo(id: string): Promise<void> {
    assertValidRepoId(id);
    const ids = await this.readManifest();
    if (!ids.includes(id)) {
      throw new RepoNotFoundError(id);
    }
    const backend = this.backendFactory(this.nsFor(id));
    await wipeTree(backend, '/');
    await this.writeManifest(ids.filter((x) => x !== id));
  }
}

/** Recursively empty a filesystem backend starting at `root`. */
async function wipeTree(backend: FsBackend, root: string): Promise<void> {
  let names: string[];
  try {
    names = await backend.promises.readdir(root);
  } catch (err) {
    if (isEnoent(err)) return;
    throw new StorageError(`Failed to list "${root}" while deleting repo.`, err);
  }
  for (const name of names) {
    const child = root === '/' ? `/${name}` : `${root}/${name}`;
    let isDir = false;
    try {
      const st = await backend.promises.stat(child);
      isDir = st.isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      await wipeTree(backend, child);
      try {
        await backend.promises.rmdir(child);
      } catch (err) {
        if (!isEnoent(err)) throw new StorageError(`Failed to remove "${child}".`, err);
      }
    } else {
      try {
        await backend.promises.unlink(child);
      } catch (err) {
        if (!isEnoent(err)) throw new StorageError(`Failed to remove "${child}".`, err);
      }
    }
  }
}
