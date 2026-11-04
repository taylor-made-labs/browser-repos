import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RepoManager } from '../src/repo-manager.js';
import {
  InvalidPathError,
  InvalidRepoIdError,
  NotFoundError,
  RepoExistsError,
  RepoNotFoundError,
} from '../src/errors.js';

/**
 * Reset IndexedDB between tests so each case starts from a clean store. This
 * also lets us simulate a fresh browser profile independent of other suites.
 */
beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});
afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});

describe('RepoManager — create / open / list / delete', () => {
  it('creates a repo, lists it, and reports existence', async () => {
    const mgr = new RepoManager();
    const repo = await mgr.createRepo('alpha');
    expect(repo.id).toBe('alpha');

    const list = await mgr.listRepos();
    expect(list.map((r) => r.id)).toEqual(['alpha']);
    expect(await mgr.hasRepo('alpha')).toBe(true);
    expect(await mgr.hasRepo('ghost')).toBe(false);
  });

  it('rejects creating a duplicate repo id', async () => {
    const mgr = new RepoManager();
    await mgr.createRepo('dup');
    await expect(mgr.createRepo('dup')).rejects.toBeInstanceOf(RepoExistsError);
  });

  it('rejects opening a non-existent repo', async () => {
    const mgr = new RepoManager();
    await expect(mgr.openRepo('nope')).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('rejects malformed repo ids', async () => {
    const mgr = new RepoManager();
    await expect(mgr.createRepo('')).rejects.toBeInstanceOf(InvalidRepoIdError);
    await expect(mgr.createRepo('../escape')).rejects.toBeInstanceOf(InvalidRepoIdError);
    await expect(mgr.createRepo('has space')).rejects.toBeInstanceOf(InvalidRepoIdError);
  });

  it('deletes a repo and removes it from the list', async () => {
    const mgr = new RepoManager();
    await mgr.createRepo('temp');
    await mgr.deleteRepo('temp');
    expect(await mgr.hasRepo('temp')).toBe(false);
    expect((await mgr.listRepos()).map((r) => r.id)).toEqual([]);
    await expect(mgr.deleteRepo('temp')).rejects.toBeInstanceOf(RepoNotFoundError);
  });
});

describe('BrowserRepo — file operations', () => {
  it('writes, reads, lists, and deletes files', async () => {
    const mgr = new RepoManager();
    const repo = await mgr.createRepo('files');

    await repo.writeFile('README.md', '# hello');
    await repo.writeFile('src/app.ts', 'export const x = 1;');

    expect(await repo.readFile('README.md')).toBe('# hello');
    expect(await repo.readFile('src/app.ts')).toBe('export const x = 1;');
    expect(await repo.exists('README.md')).toBe(true);
    expect(await repo.exists('missing.md')).toBe(false);

    const root = await repo.listFiles();
    const rootNames = root.map((e) => e.name);
    expect(rootNames).toContain('README.md');
    expect(rootNames).toContain('src');
    // .git is hidden from listings.
    expect(rootNames).not.toContain('.git');

    await repo.deleteFile('README.md');
    expect(await repo.exists('README.md')).toBe(false);
    await expect(repo.readFile('README.md')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('accepts a valid nested path and rejects a traversal attempt (required invariant)', async () => {
    const mgr = new RepoManager();
    const repo = await mgr.createRepo('paths');

    // Valid nested path passes.
    await repo.writeFile('a/b/c/deep.txt', 'ok');
    expect(await repo.readFile('a/b/c/deep.txt')).toBe('ok');

    // Traversal is rejected before touching the filesystem.
    await expect(repo.writeFile('../escape.txt', 'no')).rejects.toBeInstanceOf(InvalidPathError);
    await expect(repo.readFile('../../etc/passwd')).rejects.toBeInstanceOf(InvalidPathError);
    await expect(repo.deleteFile('/abs/escape')).rejects.toBeInstanceOf(InvalidPathError);
  });

  it('round-trips binary data losslessly', async () => {
    const mgr = new RepoManager();
    const repo = await mgr.createRepo('bin');
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
    await repo.writeFile('blob.bin', bytes);
    const back = await repo.readFileBytes('blob.bin');
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });
});

describe('Required invariant — multiple independent repos stay isolated', () => {
  it('keeps each repo\u2019s files in its own namespace', async () => {
    const mgr = new RepoManager();
    const a = await mgr.createRepo('repo-a');
    const b = await mgr.createRepo('repo-b');

    await a.writeFile('only-in-a.txt', 'A');
    await b.writeFile('only-in-b.txt', 'B');

    expect(await a.readFile('only-in-a.txt')).toBe('A');
    expect(await b.readFile('only-in-b.txt')).toBe('B');

    // Cross-repo reads must miss — files do not leak across namespaces.
    expect(await a.exists('only-in-b.txt')).toBe(false);
    expect(await b.exists('only-in-a.txt')).toBe(false);

    // Deleting one repo leaves the other fully intact.
    await mgr.deleteRepo('repo-a');
    expect(await mgr.hasRepo('repo-a')).toBe(false);
    const bStill = await mgr.openRepo('repo-b');
    expect(await bStill.readFile('only-in-b.txt')).toBe('B');
  });
});

describe('Required invariant — reopen after close keeps files intact', () => {
  it('survives dropping handles and a fresh RepoManager (simulated reload)', async () => {
    // First "session": create a repo, write files, then drop every handle.
    let mgr: RepoManager | null = new RepoManager();
    await mgr.createRepo('persist');
    let repo = await mgr.openRepo('persist');
    await repo.writeFile('keep.md', 'survive me');
    await repo.writeFile('nested/data.json', '{"n":1}');
    // Drop all references — simulates the FS handle / module going away.
    repo = null as unknown as never;
    mgr = null;

    // Second "session": brand-new manager + fresh handles, same IndexedDB.
    const mgr2 = new RepoManager();
    // The repo list persisted too.
    expect((await mgr2.listRepos()).map((r) => r.id)).toContain('persist');
    const reopened = await mgr2.openRepo('persist');
    expect(await reopened.readFile('keep.md')).toBe('survive me');
    expect(await reopened.readFile('nested/data.json')).toBe('{"n":1}');
  });
});
