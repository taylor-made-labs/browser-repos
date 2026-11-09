import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RepoManager } from '../src/repo-manager.js';

/**
 * MV3-style evidence. This is NOT a real extension run: see docs/mv3-compat.md.
 * What it proves:
 *  1. static: the code we ship, and the two runtime deps' sources, contain no eval /
 *     new Function / importScripts / dynamic remote import / localStorage / chrome.storage;
 *  2. runtime: a full git round-trip works with no window, document, localStorage, chrome
 *     and with fetch() poisoned, i.e. only IndexedDB is used (service-worker-like globals).
 */

const ROOT = join(__dirname, '..');

function listJs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listJs(p, out);
    else if (/\.(ts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Strip block and line comments so doc text like "no eval" is not flagged. */
function code(p: string): string {
  return readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ['eval()', /\beval\s*\(/],
  ['new Function', /new\s+Function\s*\(/],
  ['importScripts', /\bimportScripts\s*\(/],
  ['localStorage', /\blocalStorage\b/],
  ['chrome.storage', /\bchrome\.storage\b/],
  ['remote import', /import\s*\(\s*['"`]https?:/],
  ['remote script URL', /<script[^>]+src=/i],
];

describe('MV3 static scan', () => {
  const sources = [
    ...listJs(join(ROOT, 'src')),
    join(ROOT, 'node_modules/isomorphic-git/index.js'),
    ...listJs(join(ROOT, 'node_modules/@isomorphic-git/lightning-fs/src')),
  ];

  it('scans a non-trivial set of files', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  for (const [label, re] of FORBIDDEN) {
    it(`has no ${label} in shipped or dependency code`, () => {
      const hits = sources.filter((p) => re.test(code(p)));
      expect(hits).toEqual([]);
    });
  }

  it('only src/remote touches fetch or http', () => {
    const hits = listJs(join(ROOT, 'src'))
      .filter((p) => !p.includes(`${join('src', 'remote')}`))
      .filter((p) => /\bfetch\s*\(|XMLHttpRequest|https?:\/\//.test(code(p)));
    expect(hits).toEqual([]);
  });
});

describe('service-worker-like runtime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('commits, branches and exports using IndexedDB only', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).indexedDB = new IDBFactory();
    const g = globalThis as Record<string, unknown>;
    for (const k of ['window', 'document', 'localStorage', 'chrome']) {
      expect(g[k], `${k} must be absent in this environment`).toBeUndefined();
    }
    const fetchSpy = vi.fn(() => {
      throw new Error('network used');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const repo = await new RepoManager().createRepo('mv3');
    await repo.writeFile('a.txt', 'one');
    await repo.stage('a.txt');
    await repo.commit({ message: 'm', author: { name: 'A', email: 'a@example.com' } });
    await repo.createBranch('dev');
    await repo.checkout('dev');
    const archive = await repo.export();
    const copy = await new RepoManager().importRepo('mv3-copy', archive);

    expect(await copy.readFile('a.txt')).toBe('one');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
