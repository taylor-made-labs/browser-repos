/**
 * Slice 5 — durability harness.
 *
 * Establishes the library's durability properties with EVIDENCE, covering the
 * five required cases:
 *   (a) reopen keeps commits + branches + index intact;
 *   (b) simulated abrupt termination → consistent (not corrupt) state on reopen;
 *   (c) two conflicting mutations serialize → no corruption, consistent final;
 *   (d) quota-exceeded → a distinct typed QuotaExceededError (not generic);
 *   (e) storage-loss (store emptied under a registered repo) → a clear typed
 *       StorageLostError, never a silent empty/wrong answer.
 *
 * What is and isn't simulable in Node is documented in DURABILITY.md and noted
 * inline at case (b).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RepoManager } from '../src/repo-manager.js';
import { MutationQueue } from '../src/durability.js';
import { QuotaExceededError, StorageLostError } from '../src/errors.js';
import { StoreController } from './helpers/fault-backend.js';

const author = { name: 'Durability', email: 'durability@example.com' };

/** Namespace the manager assigns to a repo id (mirrors RepoManager internals). */
const nsFor = (id: string): string => `browser-repos:repo:${id}`;

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});
afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});

// ---------------------------------------------------------------------------
// (a) Reopen durability — commits + branches + index all survive a reopen.
// ---------------------------------------------------------------------------
describe('(a) reopen keeps commits + branches + index intact', () => {
  it('survives dropping handles and a fresh RepoManager', async () => {
    let mgr: RepoManager | null = new RepoManager();
    let repo = await mgr.createRepo('r');

    await repo.writeFile('one.txt', '1');
    await repo.stage('one.txt');
    const c1 = await repo.commit({ message: 'first', author });

    await repo.createBranch('feature', { checkout: false });

    await repo.writeFile('two.txt', '2');
    await repo.stage('two.txt');
    const c2 = await repo.commit({ message: 'second', author });

    // Leave something staged-but-uncommitted so the INDEX, not just history,
    // has to survive the reopen.
    await repo.writeFile('staged.txt', 'pending');
    await repo.stage('staged.txt');

    // Drop every handle — simulates the FS handles / module going away.
    repo = null as unknown as never;
    mgr = null;

    const mgr2 = new RepoManager();
    expect((await mgr2.listRepos()).map((x) => x.id)).toContain('r');
    const re = await mgr2.openRepo('r');

    // History intact, newest-first, same oids.
    const log = await re.log();
    expect(log.map((e) => e.oid)).toEqual([c2, c1]);
    expect(log.map((e) => e.message.trim())).toEqual(['second', 'first']);

    // Branches intact.
    expect(await re.listBranches()).toEqual(['feature', 'main']);

    // The staged-but-uncommitted index entry survived the reopen.
    expect(await re.statusOf('staged.txt')).toBe('staged');
    expect(await re.readFile('one.txt')).toBe('1');
    expect(await re.readFile('two.txt')).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// (b) Simulated abrupt termination — reopen sees a consistent, non-corrupt
//     state: EITHER the old value OR the new, never a torn mix.
//
// What we CAN simulate in Node: the "second write never happened" shape of a
// crash. fake-indexeddb only persists what an IndexedDB transaction actually
// committed; a mutation we never performed is simply absent after reopen. So we
// commit value A, then begin producing value B but drop every handle BEFORE the
// B-commit's transaction is issued, then reopen. The store must read as a whole
// A (old) — not a half-written B.
//
// What we CANNOT simulate in Node: killing a real MV3 service worker mid-
// IndexedDB-transaction (power loss during fsync). IndexedDB's transaction
// atomicity is the browser's guarantee, not ours; see DURABILITY.md. The
// library's contribution is to never leave its OWN multi-step mutation half-
// applied in a way a reopen can observe — which is what this asserts.
// ---------------------------------------------------------------------------
describe('(b) simulated abrupt termination → consistent state on reopen', () => {
  it('a mutation interrupted before it is applied leaves the prior committed state whole', async () => {
    let mgr: RepoManager | null = new RepoManager();
    let repo = await mgr.createRepo('crash');

    // Durable prior state: value A, committed.
    await repo.writeFile('doc.txt', 'A');
    await repo.stage('doc.txt');
    const cA = await repo.commit({ message: 'A', author });

    // Begin producing value B, but the "process dies" before the write that
    // would change doc.txt is ever issued: we simply drop all handles here.
    // (Nothing for B has touched the store yet.)
    repo = null as unknown as never;
    mgr = null;

    // Reopen: must be a whole A, never a torn/half-B.
    const mgr2 = new RepoManager();
    const re = await mgr2.openRepo('crash');
    expect(await re.readFile('doc.txt')).toBe('A');
    const log = await re.log();
    expect(log.map((e) => e.oid)).toEqual([cA]);
    expect((await re.status()).clean).toBe(true);
  });

  it('a crash AFTER a write committed but BEFORE the follow-up commit → new file present, history still valid', async () => {
    let mgr: RepoManager | null = new RepoManager();
    let repo = await mgr.createRepo('crash2');
    await repo.writeFile('base.txt', 'base');
    await repo.stage('base.txt');
    const c0 = await repo.commit({ message: 'base', author });

    // Write + stage a new file (these transactions commit), then "crash"
    // before the commit that would record them in history.
    await repo.writeFile('wip.txt', 'half-done');
    await repo.stage('wip.txt');
    repo = null as unknown as never;
    mgr = null;

    const mgr2 = new RepoManager();
    const re = await mgr2.openRepo('crash2');
    // History is exactly the one real commit — the never-issued commit is absent.
    expect((await re.log()).map((e) => e.oid)).toEqual([c0]);
    // The working file + staged index entry are present and CONSISTENT: the
    // store is readable, the repo opens, nothing is corrupt. The staged change
    // can simply be committed now — recoverable, not broken.
    expect(await re.readFile('wip.txt')).toBe('half-done');
    expect(await re.statusOf('wip.txt')).toBe('staged');
    const recommitted = await re.commit({ message: 'recovered wip', author });
    expect((await re.log()).map((e) => e.oid)).toEqual([recommitted, c0]);
  });
});

// ---------------------------------------------------------------------------
// (c) Conflicting mutations serialize — no corruption, no lost update.
//
// The pre-slice-5 probe proved that two overlapping stage+commit cycles raced
// on the shared index and SILENTLY LOST one commit. With the per-repo mutation
// queue, both land.
// ---------------------------------------------------------------------------
describe('(c) conflicting mutations serialize → no corruption, consistent final', () => {
  it('two overlapping commit cycles both land (no silent lost update)', async () => {
    const mgr = new RepoManager();
    const repo = await mgr.createRepo('serial');
    await repo.writeFile('seed.txt', 'seed');
    await repo.stage('seed.txt');
    await repo.commit({ message: 'seed', author });

    // Fire two full stage+commit cycles concurrently, each as ONE serialized
    // transaction. Without runExclusive the sequences would interleave between
    // steps and one commit would find nothing newly staged; with it each cycle
    // is atomic and both land as separate commits.
    const results = await Promise.allSettled([
      repo.runExclusive(async (tx) => {
        await tx.writeFile('p.txt', 'P');
        await tx.stage('p.txt');
        return tx.commit({ message: 'P', author });
      }),
      repo.runExclusive(async (tx) => {
        await tx.writeFile('q.txt', 'Q');
        await tx.stage('q.txt');
        return tx.commit({ message: 'Q', author });
      }),
    ]);
    // Both cycles succeed.
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    // History holds all THREE commits — nothing was lost.
    const messages = (await repo.log()).map((e) => e.message.trim());
    expect(messages).toContain('seed');
    expect(messages).toContain('P');
    expect(messages).toContain('Q');
    expect(messages.length).toBe(3);

    // Both files are present and whole.
    expect(await repo.readFile('p.txt')).toBe('P');
    expect(await repo.readFile('q.txt')).toBe('Q');
  });

  it('concurrent writes to the same path resolve to one whole value, never a torn mix', async () => {
    const mgr = new RepoManager();
    const repo = await mgr.createRepo('samefile');
    await Promise.all([
      repo.writeFile('same.txt', 'AAAAAAAA'),
      repo.writeFile('same.txt', 'BBBBBBBB'),
    ]);
    const val = await repo.readFile('same.txt');
    expect(['AAAAAAAA', 'BBBBBBBB']).toContain(val);
  });

  it('MutationQueue runs in FIFO submission order and survives a rejected task', async () => {
    const q = new MutationQueue();
    const order: number[] = [];
    const settle = async (n: number, ms: number): Promise<number> => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(n);
      return n;
    };
    // Submit out of natural completion order; the queue must still run 1,2,3.
    const p1 = q.run(() => settle(1, 30));
    const pFail = q.run(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('boom');
    });
    const p3 = q.run(() => settle(3, 1));
    await expect(pFail).rejects.toThrow('boom'); // rejection reaches its caller
    await Promise.all([p1, p3]);
    expect(order).toEqual([1, 3]); // a failure did not poison later tasks
    await q.drain();
  });
});

// ---------------------------------------------------------------------------
// (d) Quota exceeded → a DISTINCT typed QuotaExceededError (not generic).
// ---------------------------------------------------------------------------
describe('(d) quota-exceeded surfaces a distinct typed error', () => {
  it('a quota throw on a file write becomes QuotaExceededError with code QUOTA_EXCEEDED', async () => {
    const ctrl = new StoreController();
    const mgr = new RepoManager({ backendFactory: ctrl.factory });
    const repo = await mgr.createRepo('quota');

    ctrl.failNextWrite(nsFor('quota'), 'quota');
    let caught: unknown;
    try {
      await repo.writeFile('big.bin', 'x'.repeat(1000));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuotaExceededError);
    expect((caught as QuotaExceededError).code).toBe('QUOTA_EXCEEDED');
    // The original DOMException is preserved as the cause.
    expect((caught as { cause?: { name?: string } }).cause?.name).toBe('QuotaExceededError');
  });

  it('a quota error is NOT the generic storage error (distinct code)', async () => {
    const ctrl = new StoreController();
    const mgr = new RepoManager({ backendFactory: ctrl.factory });
    const repo = await mgr.createRepo('quota2');
    await repo.writeFile('ok.txt', 'ok'); // a normal write works

    ctrl.failNextWrite(nsFor('quota2'), 'quota');
    const err = await repo.writeFile('fail.txt', 'data').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect((err as QuotaExceededError).code).not.toBe('STORAGE_ERROR');

    // And the repo is still usable after a surfaced quota error (write recovers).
    await repo.writeFile('after.txt', 'recovered');
    expect(await repo.readFile('after.txt')).toBe('recovered');
  });
});

// ---------------------------------------------------------------------------
// (e) Storage loss → a clear typed StorageLostError, not a silent wrong answer.
// ---------------------------------------------------------------------------
describe('(e) storage-loss surfaces a clear typed error, never a silent empty', () => {
  it('checkIntegrity flags a repo whose store was emptied under it', async () => {
    const ctrl = new StoreController();
    const mgr = new RepoManager({ backendFactory: ctrl.factory });
    await mgr.createRepo('alive');
    const lost = await mgr.createRepo('lost');
    await lost.writeFile('data.txt', 'present');

    // Healthy before loss.
    let report = await mgr.checkIntegrity();
    expect(report.healthy).toBe(true);

    // Evict one repo's backing store out from under the still-registered id.
    ctrl.loseStore(nsFor('lost'));

    report = await mgr.checkIntegrity();
    expect(report.healthy).toBe(false);
    const byId = Object.fromEntries(report.repos.map((r) => [r.id, r.status]));
    expect(byId['lost']).toBe('lost');
    expect(byId['alive']).toBe('ok');
  });

  it('openRepoChecked throws StorageLostError instead of returning an empty repo', async () => {
    const ctrl = new StoreController();
    const mgr = new RepoManager({ backendFactory: ctrl.factory });
    const repo = await mgr.createRepo('vanish');
    await repo.writeFile('keep.txt', 'data');
    await repo.stage('keep.txt');
    await repo.commit({ message: 'c', author });

    ctrl.loseStore(nsFor('vanish'));

    // The id is still in the registry, so the naive open would hand back a
    // freshly re-init'd EMPTY repo — a silent wrong answer. The checked open
    // refuses it loudly instead.
    await expect(mgr.openRepoChecked('vanish')).rejects.toBeInstanceOf(StorageLostError);
    const err = await mgr.openRepoChecked('vanish').catch((e: unknown) => e);
    expect((err as StorageLostError).code).toBe('STORAGE_LOST');
  });

  it('a genuinely healthy repo passes the checked open', async () => {
    const ctrl = new StoreController();
    const mgr = new RepoManager({ backendFactory: ctrl.factory });
    const repo = await mgr.createRepo('healthy');
    await repo.writeFile('f.txt', 'v');
    const re = await mgr.openRepoChecked('healthy');
    expect(await re.readFile('f.txt')).toBe('v');
    expect((await mgr.checkIntegrity()).healthy).toBe(true);
  });
});
