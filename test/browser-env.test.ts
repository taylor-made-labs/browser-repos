/**
 * Real-browser defects found by the user-tailored-ui e2e suite:
 *  D1: "Buffer is not defined" — isomorphic-git needs a global Buffer a browser lacks.
 *  D2: a commit was not in IndexedDB when commit() resolved (LightningFS debounces
 *      its directory index ~500ms), so an immediate reload lost it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';

const author = { name: 'T', email: 't@example.com' };

beforeEach(() => {
  (globalThis as { indexedDB: unknown }).indexedDB = new IDBFactory();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('D1: works with no Node Buffer global', () => {
  it('stages and commits when globalThis.Buffer is absent', async () => {
    vi.resetModules();
    vi.stubGlobal('Buffer', undefined);
    expect((globalThis as { Buffer?: unknown }).Buffer).toBeUndefined();
    const { RepoManager } = await import('../src/repo-manager.js');
    const repo = await new RepoManager().createRepo('nobuf');
    await repo.writeFile('a.txt', 'hello');
    await repo.stage('a.txt');
    const oid = await repo.commit({ message: 'm', author });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.readFile('a.txt')).toBe('hello');
    // The polyfill installed itself rather than relying on the host.
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('function');
  });
});

describe('D2: resolved mutations are already in IndexedDB', () => {
  it('a fresh handle opened right after commit() sees the commit', async () => {
    const { RepoManager } = await import('../src/repo-manager.js');
    const repo = await new RepoManager().createRepo('durable');
    await repo.runExclusive(async (tx) => {
      await tx.writeFile('a.txt', 'one');
      await tx.stage('a.txt');
      await tx.commit({ message: 'one', author });
    });
    // No waiting: a new RepoManager reads only what IndexedDB holds (a page reload).
    const reopened = await new RepoManager().openRepo('durable');
    expect((await reopened.log()).map((c) => c.message.trim())).toEqual(['one']);
    expect(await reopened.readFile('a.txt')).toBe('one');
  });

  it('createRepo is registered durably too', async () => {
    const { RepoManager } = await import('../src/repo-manager.js');
    await new RepoManager().createRepo('reg');
    expect(await new RepoManager().hasRepo('reg')).toBe(true);
  });
});
