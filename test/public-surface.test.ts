/**
 * Public-surface test (slice 6).
 *
 * This test imports EVERYTHING it uses from the package entry point
 * (`../src/index.js`) and from nowhere else — no deep module paths. It then
 * drives the whole main flow (create → write → stage → commit → branch →
 * checkout → export → import) end to end. If the public surface were missing
 * any symbol an adopter needs, this file would fail to type-check or run, so it
 * proves the entry point is sufficient on its own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

// The ONE import line an outside adopter is allowed to write.
import {
  RepoManager,
  BrowserRepo,
  VERSION,
  type CommitAuthor,
  type StatusReport,
  type CommitEntry,
} from '../src/index.js';

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});
afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});

const author: CommitAuthor = { name: 'Ada Lovelace', email: 'ada@example.com' };

describe('public surface — entry point is sufficient for the main flow', () => {
  it('exposes the entry symbols', () => {
    expect(typeof RepoManager).toBe('function');
    expect(typeof BrowserRepo).toBe('function');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('runs create → write → commit → branch → checkout → export → import via the public API only', async () => {
    const manager = new RepoManager();

    // Create + write + commit.
    const repo = await manager.createRepo('notes');
    expect(repo).toBeInstanceOf(BrowserRepo);
    await repo.writeFile('README.md', '# My notes\n');
    await repo.writeFile('ideas/first.md', 'hello world\n');
    await repo.stage('README.md');
    await repo.stage('ideas/first.md');
    const oid = await repo.commit({ message: 'Initial commit', author });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);

    // Status + log through the public surface.
    const status: StatusReport = await repo.status();
    expect(status.clean).toBe(true);
    const log: CommitEntry[] = await repo.log();
    expect(log).toHaveLength(1);
    expect(log[0]?.message.trim()).toBe('Initial commit');

    // Branch + checkout isolation.
    await repo.createBranch('draft', { checkout: true });
    expect(await repo.currentBranch()).toBe('draft');
    await repo.writeFile('ideas/second.md', 'draft-only\n');
    await repo.stage('ideas/second.md');
    await repo.commit({ message: 'Add a draft', author });

    await repo.checkout('main');
    expect(await repo.exists('ideas/second.md')).toBe(false); // isolated to draft
    await repo.checkout('draft');
    expect(await repo.exists('ideas/second.md')).toBe(true); // back again

    // Export + import round-trip.
    const archive = await repo.export();
    expect(archive).toBeInstanceOf(Uint8Array);
    expect(archive.byteLength).toBeGreaterThan(0);

    const restored = await manager.importRepo('notes-copy', archive);
    expect(restored).toBeInstanceOf(BrowserRepo);
    expect(await restored.readFile('README.md')).toBe('# My notes\n');
    expect(await restored.currentBranch()).toBe('draft');
    const restoredBranches = await restored.listBranches();
    expect(restoredBranches).toContain('main');
    expect(restoredBranches).toContain('draft');
  });

  it('exposes repo management (list / has / integrity / delete) via the entry point', async () => {
    const manager = new RepoManager();
    await manager.createRepo('a');
    await manager.createRepo('b');

    const list = await manager.listRepos();
    expect(list.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(await manager.hasRepo('a')).toBe(true);

    const integrity = await manager.checkIntegrity();
    expect(integrity.healthy).toBe(true);
    expect(integrity.repos.map((r) => r.id).sort()).toEqual(['a', 'b']);

    await manager.deleteRepo('a');
    expect(await manager.hasRepo('a')).toBe(false);
  });
});
