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
import { importRepo as importIntoFs } from './export-import.js';
import { classifyStorageError, MutationQueueRegistry } from './durability.js';
import {
  InvalidRepoIdError,
  QuotaExceededError,
  RepoExistsError,
  RepoNotFoundError,
  StorageError,
  StorageLostError,
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

/** The health of one registered repository's backing store. */
export interface RepoIntegrity {
  /** The repository id, as recorded in the registry. */
  id: string;
  /**
   * `ok` — the store holds data for this repo.
   * `lost` — the registry knows this id but its store is empty/evicted; reading
   * it would silently return a wrong (empty) answer, so it is surfaced instead.
   */
  status: 'ok' | 'lost';
}

/** A whole-manager integrity report, returned by {@link RepoManager.checkIntegrity}. */
export interface IntegrityReport {
  /** True when every registered repo has backing data. */
  healthy: boolean;
  /** Per-repo health, one entry per registered id. */
  repos: RepoIntegrity[];
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
  /**
   * One mutation queue per repo id, shared by every handle this manager hands
   * out for that id, so all mutations to a repo serialize even across separate
   * `openRepo` calls on the same manager.
   */
  private readonly mutationQueues = new MutationQueueRegistry();

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
      if (classifyStorageError(err) === 'quota') {
        throw new QuotaExceededError(
          'Failed to persist the repository registry: the browser storage quota was exceeded.',
          err,
        );
      }
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
    const repo = new BrowserRepo(id, backend, this.mutationQueues.for(id));
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
    const repo = new BrowserRepo(id, backend, this.mutationQueues.for(id));
    // Re-ensure init so a fresh handle after reopen has a usable working tree;
    // git.init is idempotent and does not destroy existing content.
    await repo.ensureInitialized();
    return repo;
  }

  /**
   * Reconstruct a repository from an archive produced by {@link BrowserRepo.export}.
   *
   * Creates a new repository under `id` (a fresh IndexedDB namespace) whose
   * filesystem is written byte-for-byte from the archive: same files and bytes,
   * same branches, same commit oids and history, same staged and untracked
   * state, and the same current branch. Unlike {@link createRepo}, this does
   * **not** run `git.init` — the archive already carries the full `.git`, and
   * re-initializing would clobber it.
   *
   * Every archive entry's path is validated before any write (traversal /
   * absolute / malformed / oversize entries are rejected). A rejected or
   * malformed archive leaves no repo behind: the new namespace is wiped and the
   * id is not added to the registry.
   *
   * @throws {InvalidRepoIdError} if the id is malformed.
   * @throws {RepoExistsError} if a repo with that id already exists.
   * @throws {InvalidArchiveError} if the archive is structurally invalid.
   * @throws {ArchiveEntryRejectedError} if any entry fails validation.
   */
  async importRepo(id: string, archive: Uint8Array): Promise<BrowserRepo> {
    assertValidRepoId(id);
    const ids = await this.readManifest();
    if (ids.includes(id)) {
      throw new RepoExistsError(id);
    }
    const backend = this.backendFactory(this.nsFor(id));
    const repo = new BrowserRepo(id, backend, this.mutationQueues.for(id));
    try {
      await importIntoFs(backend.fs, repo.workDir, archive);
    } catch (err) {
      // importIntoFs already rolls back its own writes on failure; just make
      // sure the namespace is clean and do not register the id.
      await wipeTree(backend, '/').catch(() => undefined);
      throw err;
    }
    await this.writeManifest([...ids, id]);
    return repo;
  }

  /**
   * Check every registered repository's backing store and report which, if any,
   * have been lost (registry knows the id but the store is empty/evicted).
   *
   * This is the storage-loss surfacing required by the durability contract:
   * without it, a lost store reads as an empty-but-valid repo and a caller
   * silently gets the wrong answer. With it, the caller can detect the loss and
   * offer recovery (e.g. re-import from an export).
   */
  async checkIntegrity(): Promise<IntegrityReport> {
    const ids = await this.readManifest();
    const repos: RepoIntegrity[] = [];
    for (const id of ids) {
      const empty = await this.isStoreEmpty(id);
      repos.push({ id, status: empty ? 'lost' : 'ok' });
    }
    return { healthy: repos.every((r) => r.status === 'ok'), repos };
  }

  /**
   * Open a repository, but first assert its backing store still holds data.
   *
   * Identical to {@link openRepo} on a healthy repo. If the repo is registered
   * but its store was lost, this throws {@link StorageLostError} rather than
   * returning a handle that would read as empty — so a lost store never
   * masquerades as a valid empty repo.
   *
   * @throws {RepoNotFoundError} if no repo with that id exists.
   * @throws {StorageLostError} if the repo's backing store is empty/lost.
   */
  async openRepoChecked(id: string): Promise<BrowserRepo> {
    assertValidRepoId(id);
    const ids = await this.readManifest();
    if (!ids.includes(id)) {
      throw new RepoNotFoundError(id);
    }
    if (await this.isStoreEmpty(id)) {
      throw new StorageLostError(id);
    }
    return this.openRepo(id);
  }

  /**
   * Whether a repo's backing store has no working-tree data. A healthy repo
   * always has an initialized `.git` under its work dir, so an empty (or
   * missing) namespace means the store was never written or was lost.
   */
  private async isStoreEmpty(id: string): Promise<boolean> {
    const backend = this.backendFactory(this.nsFor(id));
    try {
      const names = await backend.promises.readdir('/');
      if (names.length === 0) return true;
      // A live repo has a /work directory with a .git inside it.
      if (!names.includes('work')) return true;
      const work = await backend.promises.readdir('/work');
      return !work.includes('.git');
    } catch (err) {
      if (isEnoent(err)) return true;
      // An unexpected read fault is not a clean "empty" signal; treat the store
      // as present so the loss path never fires on a transient read error.
      return false;
    }
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
    await this.mutationQueues.release(id);
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
