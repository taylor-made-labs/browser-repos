import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RepoManager } from '../src/repo-manager.js';
import type { BrowserRepo } from '../src/repo.js';
import { InvalidPathError, NothingStagedError } from '../src/errors.js';

/**
 * Reset IndexedDB between tests so each git-ops case starts from a clean store,
 * exactly as the lifecycle suite does.
 */
beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});
afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});

const AUTHOR = { name: 'Ada Lovelace', email: 'ada@example.com' };

async function freshRepo(id = 'git-ops'): Promise<BrowserRepo> {
  const mgr = new RepoManager();
  return mgr.createRepo(id);
}

/** Pull one entry's status out of a report by path, or undefined. */
function statusFor(
  report: Awaited<ReturnType<BrowserRepo['status']>>,
  path: string,
): string | undefined {
  return report.files.find((f) => f.path === path)?.status;
}

describe('(a) write → untracked, stage → staged', () => {
  it('reports a new file untracked, then staged after add', async () => {
    const repo = await freshRepo();
    await repo.writeFile('notes.txt', 'first');

    const before = await repo.status();
    expect(before.clean).toBe(false);
    expect(statusFor(before, 'notes.txt')).toBe('untracked');
    expect(await repo.statusOf('notes.txt')).toBe('untracked');

    await repo.stage('notes.txt');

    const after = await repo.status();
    expect(statusFor(after, 'notes.txt')).toBe('staged');
    expect(await repo.statusOf('notes.txt')).toBe('staged');
  });
});

describe('(b) commit staged files → log shows the commit, tree clean', () => {
  it('commits, logs exactly that commit with the right message/author, and is clean after', async () => {
    const repo = await freshRepo();
    await repo.writeFile('a.txt', 'alpha');
    await repo.writeFile('b.txt', 'beta');
    await repo.stage('a.txt');
    await repo.stage('b.txt');

    const oid = await repo.commit({ message: 'initial commit', author: AUTHOR });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);

    const log = await repo.log();
    expect(log).toHaveLength(1);
    const [entry] = log;
    expect(entry).toBeDefined();
    if (!entry) throw new Error('unreachable: log entry missing');
    expect(entry.oid).toBe(oid);
    // isomorphic-git normalizes the message with a trailing newline.
    expect(entry.message.trim()).toBe('initial commit');
    expect(entry.author.name).toBe(AUTHOR.name);
    expect(entry.author.email).toBe(AUTHOR.email);
    expect(entry.parents).toEqual([]);
    expect(typeof entry.timestamp).toBe('number');

    const after = await repo.status();
    expect(after.clean).toBe(true);
    expect(after.files).toEqual([]);
  });

  it('uses a distinct committer when supplied, author unchanged', async () => {
    const repo = await freshRepo();
    await repo.writeFile('c.txt', 'gamma');
    await repo.stage('c.txt');
    const committer = { name: 'Grace Hopper', email: 'grace@example.com' };
    await repo.commit({ message: 'with committer', author: AUTHOR, committer });

    const [entry] = await repo.log();
    if (!entry) throw new Error('unreachable: log entry missing');
    // The library surfaces the author identity on the log entry.
    expect(entry.author.name).toBe(AUTHOR.name);
  });
});

describe('(c) multiple commits → newest-first, depth truncates', () => {
  it('returns commits newest-first and honors a depth limit', async () => {
    const repo = await freshRepo();

    await repo.writeFile('f1.txt', '1');
    await repo.stage('f1.txt');
    const o1 = await repo.commit({ message: 'c1', author: AUTHOR });

    await repo.writeFile('f2.txt', '2');
    await repo.stage('f2.txt');
    const o2 = await repo.commit({ message: 'c2', author: AUTHOR });

    await repo.writeFile('f3.txt', '3');
    await repo.stage('f3.txt');
    const o3 = await repo.commit({ message: 'c3', author: AUTHOR });

    const full = await repo.log();
    expect(full.map((e) => e.oid)).toEqual([o3, o2, o1]);
    expect(full.map((e) => e.message.trim())).toEqual(['c3', 'c2', 'c1']);
    // Parent linkage: newest points at the previous commit; root has none.
    expect(full[0]?.parents).toEqual([o2]);
    expect(full[2]?.parents).toEqual([]);

    const limited = await repo.log({ depth: 2 });
    expect(limited.map((e) => e.oid)).toEqual([o3, o2]);

    const one = await repo.log({ depth: 1 });
    expect(one.map((e) => e.oid)).toEqual([o3]);
  });
});

describe('(d) unstage → file returns to unstaged/untracked', () => {
  it('returns a freshly-staged new file to untracked', async () => {
    const repo = await freshRepo();
    await repo.writeFile('u.txt', 'content');
    await repo.stage('u.txt');
    expect(await repo.statusOf('u.txt')).toBe('staged');

    await repo.unstage('u.txt');
    expect(await repo.statusOf('u.txt')).toBe('untracked');
    expect(statusFor(await repo.status(), 'u.txt')).toBe('untracked');
  });

  it('returns a staged edit of a tracked file to modified (unstaged)', async () => {
    const repo = await freshRepo();
    await repo.writeFile('t.txt', 'v1');
    await repo.stage('t.txt');
    await repo.commit({ message: 'base', author: AUTHOR });

    await repo.writeFile('t.txt', 'v2');
    await repo.stage('t.txt');
    expect(await repo.statusOf('t.txt')).toBe('staged');

    await repo.unstage('t.txt');
    expect(await repo.statusOf('t.txt')).toBe('modified');
  });
});

describe('(e) edges — nothing staged, empty repo, staged deletion', () => {
  it('throws NothingStagedError when committing with nothing staged', async () => {
    const repo = await freshRepo();
    await expect(repo.commit({ message: 'empty', author: AUTHOR })).rejects.toBeInstanceOf(
      NothingStagedError,
    );

    // A new-but-unstaged file is still "nothing staged".
    await repo.writeFile('loose.txt', 'x');
    await expect(repo.commit({ message: 'still empty', author: AUTHOR })).rejects.toBeInstanceOf(
      NothingStagedError,
    );
  });

  it('reports a sane status on an empty repo and an empty log', async () => {
    const repo = await freshRepo();
    const status = await repo.status();
    expect(status.clean).toBe(true);
    expect(status.files).toEqual([]);
    expect(await repo.log()).toEqual([]);
    expect(await repo.log({ depth: 5 })).toEqual([]);
  });

  it('stages a removal and reports the deletion, then commits it', async () => {
    const repo = await freshRepo();
    await repo.writeFile('gone.txt', 'bye');
    await repo.stage('gone.txt');
    await repo.commit({ message: 'add gone', author: AUTHOR });

    await repo.deleteFile('gone.txt');
    // Working-tree deletion, not yet staged.
    expect(await repo.statusOf('gone.txt')).toBe('deleted');

    await repo.stageRemoval('gone.txt');
    expect(await repo.statusOf('gone.txt')).toBe('staged-deletion');

    const oid = await repo.commit({ message: 'remove gone', author: AUTHOR });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    const after = await repo.status();
    expect(after.clean).toBe(true);
    expect(await repo.log()).toHaveLength(2);
  });
});

describe('path validation flows through git ops', () => {
  it('rejects traversal in stage / unstage / statusOf', async () => {
    const repo = await freshRepo();
    await expect(repo.stage('../escape.txt')).rejects.toBeInstanceOf(InvalidPathError);
    await expect(repo.unstage('../escape.txt')).rejects.toBeInstanceOf(InvalidPathError);
    await expect(repo.statusOf('/abs/path')).rejects.toBeInstanceOf(InvalidPathError);
  });
});
