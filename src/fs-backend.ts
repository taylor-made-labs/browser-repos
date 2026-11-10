/**
 * Filesystem backend port.
 *
 * The library talks to an IndexedDB-backed filesystem only through this port.
 * The default adapter is {@link LightningFsBackend}, which builds a
 * `@isomorphic-git/lightning-fs` handle (IndexedDB-only — never `localStorage`,
 * never `chrome.storage`). Each repository gets its own backend instance under
 * a distinct IndexedDB namespace, so repos never collide.
 *
 * The port exists so durability tests can drive the same code against a
 * swappable backend, and so a later slice could add an alternative store
 * without touching repo logic.
 */

import LightningFS from '@isomorphic-git/lightning-fs';

/**
 * The subset of a Node-style promises filesystem that the library uses.
 * Mirrors the `fs.promises`-shaped object isomorphic-git expects, so a backend
 * can be handed straight to isomorphic-git as its `fs`.
 */
export interface PromiseFs {
  readFile(path: string, options?: { encoding?: 'utf8' } | 'utf8'): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string, options?: { encoding?: 'utf8' } | 'utf8'): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }>;
  lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }>;
  /**
   * Persist pending writes to IndexedDB now. LightningFS saves its directory index on a
   * ~500ms debounce, so an awaited write is not yet durable without this. Optional so
   * test backends may omit it.
   */
  flush?(): Promise<void>;
}

/**
 * An IndexedDB-backed filesystem handle for a single repository namespace.
 * `fs` is the object passed to isomorphic-git; `promises` is used directly for
 * file operations.
 */
export interface FsBackend {
  /** The IndexedDB namespace this backend is bound to. */
  readonly namespace: string;
  /** The isomorphic-git-compatible fs object (has a `.promises`). */
  readonly fs: { promises: PromiseFs };
  /** Convenience alias for `fs.promises`. */
  readonly promises: PromiseFs;
}

/**
 * Factory that produces an {@link FsBackend} for a given IndexedDB namespace.
 * Injected into the repo manager so tests and later slices can substitute a
 * different store. The default is {@link lightningFsBackendFactory}.
 */
export type FsBackendFactory = (namespace: string) => FsBackend;

/**
 * Default backend: a `@isomorphic-git/lightning-fs` instance bound to an
 * IndexedDB database named by `namespace`. IndexedDB is the only store this
 * touches — no `localStorage`, no `chrome.storage`, no network.
 */
export const lightningFsBackendFactory: FsBackendFactory = (namespace: string): FsBackend => {
  const lfs = new LightningFS(namespace);
  const fs = lfs as unknown as { promises: PromiseFs };
  return {
    namespace,
    fs,
    promises: fs.promises,
  };
};
