/**
 * A fault-injecting wrapper over the REAL LightningFS/IndexedDB backend, for
 * durability tests.
 *
 * The harness must drive genuine isomorphic-git operations (init, add, commit,
 * checkout) — which touch more of the filesystem than the library's narrow
 * {@link PromiseFs} port declares — so we do NOT reimplement a filesystem here.
 * Instead we wrap the real {@link lightningFsBackendFactory} output and
 * intercept only what a test needs to provoke:
 *
 *   - `failNextWrite('quota')` — the next `writeFile`/`mkdir` on that namespace
 *     throws a `QuotaExceededError` DOMException-shaped error, so the distinct
 *     quota path is exercised against the real store.
 *
 * Reopen durability, abrupt-termination and storage-loss are driven through the
 * real fake-indexeddb store itself (handle drops, `IDBFactory` swaps, deleting
 * the backing database), because that stack genuinely persists and can genuinely
 * be emptied — which is the point of testing durability with evidence rather
 * than against a mock that cannot lose data.
 */

import type { FsBackend, FsBackendFactory, PromiseFs } from '../../src/fs-backend.js';
import { lightningFsBackendFactory } from '../../src/fs-backend.js';

/** A faked quota-exceeded error, shaped like the browser's DOMException. */
export class FakeQuotaExceededError extends Error {
  override readonly name = 'QuotaExceededError';
  readonly code = 22;
  constructor() {
    super('The quota has been exceeded.');
  }
}

/**
 * Controls fault injection across every backend handle it hands out. One
 * controller is shared by all handles (via {@link StoreController.factory}), so
 * a fault armed before an operation fires on whichever handle performs the next
 * write to that namespace.
 */
export class StoreController {
  /** Per-namespace: throw this fault on the next write, then disarm. */
  private readonly nextWriteFault = new Map<string, 'quota'>();
  /**
   * Namespaces whose store has been "lost": a fresh handle to one of these
   * reads as an empty store (ENOENT on everything), modelling an evicted or
   * cleared IndexedDB database the library did not expect to vanish.
   *
   * We model loss at the port boundary rather than via `deleteDatabase`, because
   * LightningFS caches its superblock in-process: deleting the on-disk IDB does
   * not evict the live in-memory view, so it would not actually simulate loss in
   * a single Node process. Returning ENOENT from a fresh handle is exactly what
   * the library would see from a genuinely evicted store in the browser.
   */
  private readonly lost = new Set<string>();

  /** Hand this to `new RepoManager({ backendFactory })`. */
  readonly factory: FsBackendFactory = (namespace: string): FsBackend => {
    const real = lightningFsBackendFactory(namespace);
    return wrap(real, namespace, this);
  };

  /** @internal — consume a pending write fault for a namespace, if any. */
  takeWriteFault(namespace: string): 'quota' | undefined {
    const f = this.nextWriteFault.get(namespace);
    if (f !== undefined) this.nextWriteFault.delete(namespace);
    return f;
  }

  /** @internal — whether a namespace's store has been marked lost. */
  isLost(namespace: string): boolean {
    return this.lost.has(namespace);
  }

  /** Arm the next write to `namespace` to throw the given fault. */
  failNextWrite(namespace: string, kind: 'quota'): void {
    this.nextWriteFault.set(namespace, kind);
  }

  /** Mark a namespace's store as lost — fresh handles read it as empty. */
  loseStore(namespace: string): void {
    this.lost.add(namespace);
  }

  /** Disarm any pending fault for a namespace. */
  reset(namespace: string): void {
    this.nextWriteFault.delete(namespace);
  }
}

function wrap(real: FsBackend, namespace: string, ctrl: StoreController): FsBackend {
  // isomorphic-git binds to many more fs methods than the library's narrow
  // PromiseFs port (symlink, readlink, rename, du, …). We must therefore pass
  // the REAL promises object through untouched and intercept only writeFile and
  // mkdir — anything else forwards to the genuine LightningFS method. A Proxy
  // does exactly that: unknown props fall through to the real object.
  const realPromises = real.fs.promises as unknown as Record<string, unknown>;

  const guardWrite = (): void => {
    if (ctrl.takeWriteFault(namespace) === 'quota') {
      throw new FakeQuotaExceededError();
    }
  };

  const enoent = (path: string): Error => {
    const e = new Error(`ENOENT: no such file or directory, '${path}'`) as Error & { code: string };
    e.code = 'ENOENT';
    return e;
  };

  const call = (name: string, args: unknown[]): unknown =>
    (realPromises[name] as (...a: unknown[]) => unknown).apply(realPromises, args);

  const overrides: Record<string, unknown> = {
    writeFile: (...args: unknown[]) => {
      guardWrite();
      return call('writeFile', args);
    },
    mkdir: (...args: unknown[]) => {
      guardWrite();
      return call('mkdir', args);
    },
    // When the store is "lost", a fresh handle reads as empty: the root lists
    // nothing and every other path is absent, exactly as an evicted DB would.
    readdir: (...args: unknown[]) => {
      if (ctrl.isLost(namespace)) {
        return args[0] === '/' ? Promise.resolve([]) : Promise.reject(enoent(String(args[0])));
      }
      return call('readdir', args);
    },
    stat: (...args: unknown[]) => {
      if (ctrl.isLost(namespace)) return Promise.reject(enoent(String(args[0])));
      return call('stat', args);
    },
    lstat: (...args: unknown[]) => {
      if (ctrl.isLost(namespace)) return Promise.reject(enoent(String(args[0])));
      return call('lstat', args);
    },
    readFile: (...args: unknown[]) => {
      if (ctrl.isLost(namespace)) return Promise.reject(enoent(String(args[0])));
      return call('readFile', args);
    },
  };

  const promisesProxy = new Proxy(realPromises, {
    get(target, prop: string): unknown {
      if (prop in overrides) return overrides[prop];
      const value = target[prop];
      if (typeof value === 'function') return (value as (...a: unknown[]) => unknown).bind(target);
      return value;
    },
  }) as unknown as PromiseFs;

  return {
    namespace,
    fs: { promises: promisesProxy },
    promises: promisesProxy,
  };
}
