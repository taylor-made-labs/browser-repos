/**
 * Durability primitives for browser-repos.
 *
 * This slice hardens the library against three realities of IndexedDB-backed
 * storage in a browser, none of which the earlier slices addressed:
 *
 * 1. **Conflicting mutations interleave.** The `.git` index and refs are shared
 *    files. Two overlapping "stage + commit" cycles against one repo can race:
 *    both awaited calls resolve without error, yet one commit is silently lost
 *    because they both read-modified-wrote the same index. The fix is a
 *    per-repo {@link MutationQueue}: conflicting mutations on a repo are
 *    serialized so they run one at a time, in submission order, and the final
 *    state is always the consistent sequential result.
 *
 * 2. **Quota is finite and surfaces as an opaque throw.** A write that exceeds
 *    the browser's storage quota throws a `QuotaExceededError` `DOMException`.
 *    {@link classifyStorageError} detects it (by name, or the legacy numeric
 *    code 22) so the library can raise a *distinct* typed error rather than a
 *    generic storage fault.
 *
 * 3. **Storage can vanish.** A repo's IndexedDB store can be evicted or cleared
 *    out from under a still-registered repo. {@link isStoreEmpty} is the probe
 *    the manager uses to tell "lost store" apart from "empty but valid repo".
 *
 * Everything here is pure library logic — no UI, no network, no credentials.
 */

/**
 * Serializes async mutations so conflicting writes to one resource never
 * interleave. Each `run` is appended to a single promise chain: it does not
 * start until the previous one has settled, so there is exactly one mutation in
 * flight at a time and submission order is preserved.
 *
 * A rejected mutation does not poison the queue — the chain continues with the
 * next submission — and the rejection is still propagated to that mutation's
 * own caller. One queue is held per repository (keyed by repo id), so mutations
 * on *different* repos still run concurrently; only same-repo mutations
 * serialize.
 */
export class MutationQueue {
  /** The tail of the chain. Resolves when the queue is idle. */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Submit a mutation. It runs after every previously-submitted mutation has
   * settled, and resolves/rejects with its own result. Ordering is strictly
   * FIFO by submission.
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain off the current tail, swallowing the predecessor's outcome so one
    // failure never rejects a later mutation. The caller still sees its own.
    const result = this.tail.then(fn, fn);
    // Advance the tail, but keep it from becoming a rejected promise (which
    // would surface as an unhandled rejection and break the chain).
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves once every currently-queued mutation has settled. */
  async drain(): Promise<void> {
    await this.tail;
  }
}

/**
 * A registry of per-key {@link MutationQueue}s. The manager keeps one of these
 * and asks it for the queue bound to a repo id, so all mutations to a given
 * repo share a lock while different repos stay independent.
 */
export class MutationQueueRegistry {
  private readonly queues = new Map<string, MutationQueue>();

  /** The queue for `key`, created on first use. */
  for(key: string): MutationQueue {
    let q = this.queues.get(key);
    if (q === undefined) {
      q = new MutationQueue();
      this.queues.set(key, q);
    }
    return q;
  }

  /** Forget a key's queue once it is idle (e.g. the repo was deleted). */
  async release(key: string): Promise<void> {
    const q = this.queues.get(key);
    if (q === undefined) return;
    await q.drain();
    this.queues.delete(key);
  }
}

/**
 * Whether an error is the browser's storage-quota-exceeded signal. Matches the
 * standard `DOMException` name `QuotaExceededError`, the legacy numeric code 22,
 * and defensively a message substring, so it works across engines and across
 * the fake-indexeddb test shim.
 */
export function isQuotaExceeded(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown };
  if (e.name === 'QuotaExceededError') return true;
  // DOMException.QUOTA_EXCEEDED_ERR === 22 (legacy constant).
  if (e.code === 22) return true;
  if (typeof e.message === 'string' && /quota.*exceeded/i.test(e.message)) {
    return true;
  }
  return false;
}

/**
 * Classify a raw storage throw into a {@link StorageErrorKind}. Callers map the
 * kind onto the typed error they surface, keeping quota distinct from a generic
 * fault.
 */
export type StorageErrorKind = 'quota' | 'generic';

/** Classify a raw error from a filesystem/IndexedDB write. */
export function classifyStorageError(err: unknown): StorageErrorKind {
  return isQuotaExceeded(err) ? 'quota' : 'generic';
}
