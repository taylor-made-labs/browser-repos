/**
 * LIVE remote-sync integration test — SKIPPED BY DEFAULT.
 *
 * This is the only test that would touch a real git remote, so it must NEVER
 * run in CI (CI is offline and keyless). It is gated two ways and skipped unless
 * BOTH are present:
 *   - `BROWSER_REPOS_LIVE=1` in the environment, and
 *   - a real token in `BROWSER_REPOS_LIVE_TOKEN` and remote in
 *     `BROWSER_REPOS_LIVE_URL`.
 *
 * Even then it uses `http/node` and the caller's own token, supplied through the
 * same per-request credential hook the library uses everywhere else — the token
 * is read from the environment at request time and never written anywhere. Run
 * it by hand against a throwaway repo:
 *
 *   BROWSER_REPOS_LIVE=1 \
 *   BROWSER_REPOS_LIVE_URL=https://github.com/you/throwaway.git \
 *   BROWSER_REPOS_LIVE_TOKEN=ghp_xxx \
 *   npx vitest run test/remote-sync.live.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RepoManager } from '../src/repo-manager.js';
import { GitHubSyncTarget } from '../src/remote/github.js';

const LIVE =
  process.env.BROWSER_REPOS_LIVE === '1' &&
  !!process.env.BROWSER_REPOS_LIVE_URL &&
  !!process.env.BROWSER_REPOS_LIVE_TOKEN;

// describe.skip unless explicitly opted in — this is what keeps CI offline.
const maybe = LIVE ? describe : describe.skip;

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});
afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});

maybe('LIVE GitHub sync (opt-in only)', () => {
  it('pushes a commit to the live remote', async () => {
    // Imported lazily so CI (which never sets the env gate) never loads the
    // node http transport.
    const http = (await import('isomorphic-git/http/node')).default;
    const url = process.env.BROWSER_REPOS_LIVE_URL as string;
    const token = process.env.BROWSER_REPOS_LIVE_TOKEN as string;

    const mgr = new RepoManager();
    const repo = await mgr.createRepo('live');
    await repo.writeFile('live.txt', `hello ${Date.now()}`);
    await repo.stage('live.txt');
    await repo.commit({ message: 'live smoke', author: { name: 'CI', email: 'ci@example.com' } });

    const target = new GitHubSyncTarget({ url, http });
    const out = await target.push(repo.fsBackend.fs, repo.workDir, {
      ref: 'main',
      force: true,
      // Token read at request time, used in memory, never stored by the library.
      getCredentials: () => ({ username: token, password: 'x-oauth-basic' }),
    });
    expect(out.ok).toBe(true);
  });
});
