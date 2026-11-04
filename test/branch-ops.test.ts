import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RepoManager } from '../src/repo-manager.js';
import type { BrowserRepo } from '../src/repo.js';
import {
  BranchInUseError,
  BranchNotFoundError,
  InvalidBranchNameError,
  UncommittedChangesError,
} from '../src/errors.js';
import { assertValidBranchName } from '../src/branch-ops.js';

/**
 * Reset IndexedDB between tests so each branch case starts from a clean store,
 * exactly as the lifecycle and git-ops suites do.
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

async function freshRepo(id = 'branches'): Promise<BrowserRepo> {
  const mgr = new RepoManager();
  return mgr.createRepo(id);
}

/** Commit one file so the repo has a real HEAD to branch from. */
async function commitFile(repo: BrowserRepo, path: string, body: string, message: string): Promise<string> {
  await repo.writeFile(path, body);
  await repo.stage(path);
  return repo.commit({ message, author: AUTHOR });
}

describe('(a) create → listBranches includes it; current branch correct', () => {
  it('starts on main, creates a branch without moving HEAD, lists both sorted', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'base.txt', 'base', 'initial');

    expect(await repo.currentBranch()).toBe('main');
    expect(await repo.listBranches()).toEqual(['main']);

    await repo.createBranch('feature');

    // Branch exists but HEAD has not moved.
    expect(await repo.hasBranch('feature')).toBe(true);
    expect(await repo.listBranches()).toEqual(['feature', 'main']);
    expect(await repo.currentBranch()).toBe('main');

    // Explicit checkout moves HEAD.
    await repo.checkout('feature');
    expect(await repo.currentBranch()).toBe('feature');
  });

  it('createBranch with checkout:true moves HEAD immediately', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'base.txt', 'base', 'initial');

    await repo.createBranch('dev', { checkout: true });
    expect(await repo.currentBranch()).toBe('dev');
    expect(await repo.listBranches()).toEqual(['dev', 'main']);
  });

  it('createBranch from a named ref points the new branch at that ref', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'base.txt', 'base', 'initial');
    await repo.createBranch('release');

    // Branch "topic" off "release" rather than current HEAD; both resolve equal here.
    await repo.createBranch('topic', { from: 'release' });
    expect(await repo.listBranches()).toEqual(['main', 'release', 'topic']);
  });

  it('createBranch from a nonexistent ref throws BranchNotFoundError', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'base.txt', 'base', 'initial');
    await expect(repo.createBranch('x', { from: 'no-such-ref' })).rejects.toBeInstanceOf(
      BranchNotFoundError,
    );
  });
});

describe('(b) working-tree isolation across branches (both directions)', () => {
  it('a file committed on one branch is absent on another and reappears on return', async () => {
    const repo = await freshRepo();

    // main: commit main-only.txt.
    await commitFile(repo, 'main-only.txt', 'on main', 'main commit');
    expect(await repo.exists('main-only.txt')).toBe(true);

    // Branch feature off main, switch to it, commit a DIFFERENT file.
    await repo.createBranch('feature');
    await repo.checkout('feature');
    expect(await repo.currentBranch()).toBe('feature');

    // feature inherits main's content at branch point, then diverges.
    await commitFile(repo, 'feature-only.txt', 'on feature', 'feature commit');
    // Remove main-only on feature so the branches truly differ, then commit.
    await repo.deleteFile('main-only.txt');
    await repo.stageRemoval('main-only.txt');
    await repo.commit({ message: 'drop main-only on feature', author: AUTHOR });

    // On feature: feature-only present, main-only gone.
    expect(await repo.exists('feature-only.txt')).toBe(true);
    expect(await repo.exists('main-only.txt')).toBe(false);

    // Switch back to main: main-only present, feature-only gone.
    await repo.checkout('main');
    expect(await repo.currentBranch()).toBe('main');
    expect(await repo.exists('main-only.txt')).toBe(true);
    expect(await repo.exists('feature-only.txt')).toBe(false);

    // Switch forward to feature again: isolation holds the other direction too.
    await repo.checkout('feature');
    expect(await repo.exists('feature-only.txt')).toBe(true);
    expect(await repo.exists('main-only.txt')).toBe(false);
  });

  it('listFiles reflects only the current branch content after a switch', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'shared.txt', 'shared', 'base');

    await repo.createBranch('other', { checkout: true });
    await commitFile(repo, 'other-only.txt', 'x', 'other');

    const onOther = (await repo.listFiles()).map((e) => e.name).sort();
    expect(onOther).toEqual(['other-only.txt', 'shared.txt']);

    await repo.checkout('main');
    const onMain = (await repo.listFiles()).map((e) => e.name).sort();
    expect(onMain).toEqual(['shared.txt']);
  });
});

describe('(c) delete a branch → gone; delete current / missing → typed error', () => {
  it('deletes a non-current branch and it leaves the list', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'base.txt', 'base', 'initial');
    await repo.createBranch('temp');
    expect(await repo.listBranches()).toContain('temp');

    await repo.deleteBranch('temp');
    expect(await repo.listBranches()).not.toContain('temp');
    expect(await repo.hasBranch('temp')).toBe(false);
  });

  it('refuses to delete the current branch with BranchInUseError', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'base.txt', 'base', 'initial');
    await repo.createBranch('live', { checkout: true });
    expect(await repo.currentBranch()).toBe('live');

    await expect(repo.deleteBranch('live')).rejects.toBeInstanceOf(BranchInUseError);
    // Still present after the refusal.
    expect(await repo.hasBranch('live')).toBe(true);
  });

  it('deleting a nonexistent branch throws BranchNotFoundError', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'base.txt', 'base', 'initial');
    await expect(repo.deleteBranch('ghost')).rejects.toBeInstanceOf(BranchNotFoundError);
  });

  it('checking out a nonexistent branch throws BranchNotFoundError', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'base.txt', 'base', 'initial');
    await expect(repo.checkout('ghost')).rejects.toBeInstanceOf(BranchNotFoundError);
  });
});

describe('(d) invalid branch names are rejected', () => {
  const invalid: Array<[string, string]> = [
    ['', 'empty'],
    ['  ', 'whitespace only'],
    ['/leading', 'leading slash'],
    ['trailing/', 'trailing slash'],
    ['double//slash', 'empty component'],
    ['has space', 'space'],
    ['..', 'dot-dot'],
    ['a..b', 'contains dot-dot'],
    ['.hidden', 'leading dot'],
    ['feature/.hidden', 'component leading dot'],
    ['ends.lock', 'ends with .lock'],
    ['has~tilde', 'tilde'],
    ['has^caret', 'caret'],
    ['has:colon', 'colon'],
    ['has?question', 'question mark'],
    ['has*star', 'star'],
    ['has[bracket', 'open bracket'],
    ['has\\backslash', 'backslash'],
    ['@', 'lone at'],
    ['a@{b', 'at-brace'],
    ['ctrl\u0001char', 'control char'],
  ];

  for (const [name, why] of invalid) {
    it(`rejects ${JSON.stringify(name)} (${why}) via assertValidBranchName`, () => {
      expect(() => assertValidBranchName(name)).toThrow(InvalidBranchNameError);
    });
  }

  it('rejects an invalid name through createBranch and checkout', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'base.txt', 'base', 'initial');
    await expect(repo.createBranch('bad name')).rejects.toBeInstanceOf(InvalidBranchNameError);
    await expect(repo.checkout('bad name')).rejects.toBeInstanceOf(InvalidBranchNameError);
    await expect(repo.deleteBranch('bad name')).rejects.toBeInstanceOf(InvalidBranchNameError);
  });

  it('accepts ordinary valid names', () => {
    for (const ok of ['main', 'feature', 'feat/slice-3', 'release-1.2', 'a/b/c', 'dev_x']) {
      expect(() => assertValidBranchName(ok)).not.toThrow();
    }
  });
});

describe('(e) edge: checkout with uncommitted changes is blocked (defined behavior)', () => {
  it('refuses a switch while a tracked file has unsaved changes, then allows it after commit', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'tracked.txt', 'v1', 'initial');
    await repo.createBranch('feature');

    // Dirty the working tree: modify a tracked, committed file (unstaged).
    await repo.writeFile('tracked.txt', 'v2-uncommitted');
    await expect(repo.checkout('feature')).rejects.toBeInstanceOf(UncommittedChangesError);
    // HEAD did not move.
    expect(await repo.currentBranch()).toBe('main');

    // Commit the change; now the switch is allowed.
    await repo.stage('tracked.txt');
    await repo.commit({ message: 'save v2', author: AUTHOR });
    await repo.checkout('feature');
    expect(await repo.currentBranch()).toBe('feature');
    // feature was branched before v2, so it still has v1.
    expect(await repo.readFile('tracked.txt')).toBe('v1');
  });

  it('a staged-but-uncommitted change also blocks a switch', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'f.txt', 'v1', 'initial');
    await repo.createBranch('b');

    await repo.writeFile('f.txt', 'v2');
    await repo.stage('f.txt');
    await expect(repo.checkout('b')).rejects.toBeInstanceOf(UncommittedChangesError);
  });

  it('a purely untracked file does NOT block a switch', async () => {
    const repo = await freshRepo();
    await commitFile(repo, 'committed.txt', 'c', 'initial');
    await repo.createBranch('b');

    // Untracked scratch file: absent from HEAD and index.
    await repo.writeFile('scratch.txt', 'loose');
    await repo.checkout('b');
    expect(await repo.currentBranch()).toBe('b');
  });
});
