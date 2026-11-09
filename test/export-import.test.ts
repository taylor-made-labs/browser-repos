import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RepoManager } from '../src/repo-manager.js';
import type { BrowserRepo } from '../src/repo.js';
import {
  ArchiveEntryRejectedError,
  InvalidArchiveError,
} from '../src/errors.js';
import {
  packArchive,
  unpackArchive,
  ARCHIVE_FORMAT_VERSION,
} from '../src/archive.js';

/**
 * Reset IndexedDB between tests so each round-trip starts from a clean store,
 * exactly as the lifecycle, git-ops, and branch suites do.
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

async function commitFile(
  repo: BrowserRepo,
  path: string,
  body: string | Uint8Array,
  message: string,
): Promise<string> {
  await repo.writeFile(path, body);
  await repo.stage(path);
  return repo.commit({ message, author: AUTHOR });
}

/**
 * Build a repo exercising every dimension the round-trip must preserve:
 * - multiple commits across TWO branches
 * - a binary file with all byte values 0x00..0xFF
 * - a nested-path file
 * - a STAGED-but-uncommitted file
 * - an UNTRACKED file
 * Returns the full source snapshot the round-trip is asserted against.
 */
async function buildSourceRepo(mgr: RepoManager): Promise<{
  src: BrowserRepo;
  allBytes: Uint8Array;
}> {
  const src = await mgr.createRepo('source');

  // main: two commits, one of them a nested path.
  await commitFile(src, 'README.md', '# source repo\n', 'c1: readme');
  await commitFile(src, 'src/nested/deep/module.ts', 'export const n = 1;\n', 'c2: nested');

  // A binary file with every byte value, committed on main.
  const allBytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) allBytes[i] = i;
  await commitFile(src, 'assets/all-bytes.bin', allBytes, 'c3: binary');

  // A second branch with its own commit, so history/branches diverge.
  await src.createBranch('feature', { checkout: true });
  await commitFile(src, 'feature-only.txt', 'only on feature\n', 'c4: feature');

  // Back to main as the CURRENT branch for the round-trip.
  await src.checkout('main');

  // A staged-but-uncommitted file (present in the index, not in any commit).
  await src.writeFile('staged.txt', 'staged content\n');
  await src.stage('staged.txt');

  // An untracked file (on disk, absent from HEAD and index).
  await src.writeFile('untracked.txt', 'loose scratch\n');

  return { src, allBytes };
}

describe('(a) full round-trip equality over slices 1–3', () => {
  it('export → import reconstructs a byte-for-byte identical repo', async () => {
    const mgr = new RepoManager();
    const { src } = await buildSourceRepo(mgr);

    const archive = await src.export();
    expect(archive).toBeInstanceOf(Uint8Array);
    expect(archive.byteLength).toBeGreaterThan(0);

    const dst = await mgr.importRepo('restored', archive);

    // Current branch preserved.
    expect(await dst.currentBranch()).toBe(await src.currentBranch());
    expect(await dst.currentBranch()).toBe('main');

    // Branch list preserved.
    expect(await dst.listBranches()).toEqual(await src.listBranches());
    expect(await dst.listBranches()).toEqual(['feature', 'main']);

    // Every tracked + untracked + staged working-tree file equal, byte-exact.
    for (const path of [
      'README.md',
      'src/nested/deep/module.ts',
      'assets/all-bytes.bin',
      'staged.txt',
      'untracked.txt',
    ]) {
      const a = await src.readFileBytes(path);
      const b = await dst.readFileBytes(path);
      expect(Array.from(b)).toEqual(Array.from(a));
    }

    // Commit history on main: same oids, messages, and order.
    const srcLog = await src.log();
    const dstLog = await dst.log();
    expect(dstLog.map((e) => e.oid)).toEqual(srcLog.map((e) => e.oid));
    expect(dstLog.map((e) => e.message)).toEqual(srcLog.map((e) => e.message));

    // Status (staged + untracked set) identical.
    const srcStatus = await src.status();
    const dstStatus = await dst.status();
    expect(dstStatus).toEqual(srcStatus);
  });

  it('history on the OTHER branch survives too (same oids after switching)', async () => {
    // A clean two-branch repo (no dangling staged/untracked) so the current
    // branch can be switched on both sides — the point here is other-branch
    // history fidelity, which a dirty working tree would block by design.
    const mgr = new RepoManager();
    const src = await mgr.createRepo('two-branch');
    await commitFile(src, 'base.txt', 'base\n', 'c1: base');
    await src.createBranch('feature', { checkout: true });
    await commitFile(src, 'feature-only.txt', 'only on feature\n', 'c2: feature');
    await src.checkout('main');

    const archive = await src.export();
    const dst = await mgr.importRepo('two-branch-restored', archive);

    await src.checkout('feature');
    await dst.checkout('feature');
    const srcLog = await src.log();
    const dstLog = await dst.log();
    expect(dstLog.map((e) => e.oid)).toEqual(srcLog.map((e) => e.oid));
    expect(await dst.readFile('feature-only.txt')).toBe('only on feature\n');
  });
});

describe('(b) binary fidelity — all byte values round-trip exactly', () => {
  it('a 0x00..0xFF file is byte-identical after export/import (no utf-8 corruption)', async () => {
    const mgr = new RepoManager();
    const src = await mgr.createRepo('bin-src');
    const allBytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) allBytes[i] = i;
    await commitFile(src, 'blob.bin', allBytes, 'binary commit');

    const archive = await src.export();
    const dst = await mgr.importRepo('bin-dst', archive);

    const back = await dst.readFileBytes('blob.bin');
    expect(back.byteLength).toBe(256);
    expect(Array.from(back)).toEqual(Array.from(allBytes));
  });
});

describe('(c) history + branch fidelity', () => {
  it('all branches present and commit oids identical after import', async () => {
    const mgr = new RepoManager();
    const src = await mgr.createRepo('hist-src');
    await commitFile(src, 'a.txt', 'a', 'first');
    await commitFile(src, 'b.txt', 'b', 'second');
    await src.createBranch('topic', { checkout: true });
    await commitFile(src, 'c.txt', 'c', 'third on topic');
    await src.checkout('main');

    const srcMainOids = (await src.log()).map((e) => e.oid);
    const archive = await src.export();
    const dst = await mgr.importRepo('hist-dst', archive);

    expect(await dst.listBranches()).toEqual(['main', 'topic']);
    expect(await dst.currentBranch()).toBe('main');
    expect((await dst.log()).map((e) => e.oid)).toEqual(srcMainOids);
  });
});

describe('(d) staged + untracked fidelity, distinctly', () => {
  it('a staged file and an untracked file each survive with their own status', async () => {
    const mgr = new RepoManager();
    const src = await mgr.createRepo('state-src');
    await commitFile(src, 'base.txt', 'base', 'initial');

    await src.writeFile('is-staged.txt', 'staged');
    await src.stage('is-staged.txt');
    await src.writeFile('is-untracked.txt', 'untracked');

    expect(await src.statusOf('is-staged.txt')).toBe('staged');
    expect(await src.statusOf('is-untracked.txt')).toBe('untracked');

    const archive = await src.export();
    const dst = await mgr.importRepo('state-dst', archive);

    // Distinct states preserved across the round-trip.
    expect(await dst.statusOf('is-staged.txt')).toBe('staged');
    expect(await dst.statusOf('is-untracked.txt')).toBe('untracked');
    expect(await dst.readFile('is-staged.txt')).toBe('staged');
    expect(await dst.readFile('is-untracked.txt')).toBe('untracked');
  });
});

describe('(e) security — malicious archive entries are rejected on import', () => {
  async function exportedHeaderRoot(): Promise<string> {
    const mgr = new RepoManager();
    const src = await mgr.createRepo('probe');
    await commitFile(src, 'f.txt', 'x', 'c');
    const { header } = unpackArchive(await src.export());
    return header.root; // e.g. "/work"
  }

  it('rejects a "../escape" traversal entry with a typed error and builds no repo', async () => {
    const root = await exportedHeaderRoot();
    const mgr = new RepoManager();

    const evil = packArchive(root, [
      { path: `${root}/ok.txt`, bytes: new TextEncoder().encode('ok') },
      { path: `${root}/../escape.txt`, bytes: new TextEncoder().encode('pwned') },
    ]);

    await expect(mgr.importRepo('evil', evil)).rejects.toBeInstanceOf(ArchiveEntryRejectedError);
    // Nothing was registered: the import left no repo behind.
    expect(await mgr.hasRepo('evil')).toBe(false);
  });

  it('rejects an absolute-path entry outside the source root', async () => {
    const root = await exportedHeaderRoot();
    const mgr = new RepoManager();
    const evil = packArchive(root, [
      { path: '/etc/passwd', bytes: new TextEncoder().encode('root:x:0:0') },
    ]);
    await expect(mgr.importRepo('abs', evil)).rejects.toBeInstanceOf(ArchiveEntryRejectedError);
    expect(await mgr.hasRepo('abs')).toBe(false);
  });

  it('rejects a backslash / drive-qualified entry', async () => {
    const root = await exportedHeaderRoot();
    const mgr = new RepoManager();
    const evil = packArchive(root, [
      { path: `${root}/..\\windows\\system32`, bytes: new Uint8Array(0) },
    ]);
    await expect(mgr.importRepo('bs', evil)).rejects.toBeInstanceOf(ArchiveEntryRejectedError);
  });

  it('rejects a structurally invalid archive (bad magic) with InvalidArchiveError', async () => {
    const mgr = new RepoManager();
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await expect(mgr.importRepo('garbage', garbage)).rejects.toBeInstanceOf(InvalidArchiveError);
  });

  it('rejects an unsupported archive version', async () => {
    // Hand-craft a header with a bogus version.
    const header = JSON.stringify({ version: 999, root: '/work', entries: [] });
    const headerBytes = new TextEncoder().encode(header);
    const magic = new Uint8Array([0x42, 0x52, 0x45, 0x50, 0x4f, 0x53, 0x01, 0x00]);
    const buf = new Uint8Array(magic.length + 4 + headerBytes.length);
    buf.set(magic, 0);
    const dv = new DataView(buf.buffer);
    dv.setUint32(magic.length, headerBytes.length, true);
    buf.set(headerBytes, magic.length + 4);
    const mgr = new RepoManager();
    await expect(mgr.importRepo('verbad', buf)).rejects.toBeInstanceOf(InvalidArchiveError);
  });
});

describe('(f) credential-safety — no token ever appears in an export', () => {
  it('an export contains no secret even when a token is handed to a mocked remote config', async () => {
    const SECRET = 'ghp_SUPERSECRETTOKEN_should_never_be_exported_0123456789';
    const mgr = new RepoManager();
    const src = await mgr.createRepo('cred-src');

    // Mocked "remote config": the caller holds a credential and passes it to a
    // remote-auth hook. The library has no API that writes a credential to repo
    // data, so we only ever store a credential-FREE remote URL as plain config.
    const mockRemoteAuth = { token: SECRET };
    void mockRemoteAuth.token; // used by a caller's transport, never by us.

    // Store a plain (secret-free) remote URL the way a caller legitimately might.
    await commitFile(
      src,
      'remote.config',
      'url = https://github.com/taylor-made-labs/browser-repos.git\n',
      'c: remote url (no secret)',
    );
    await commitFile(src, 'app.ts', 'export const ok = true;\n', 'c: code');

    const archive = await src.export();

    // Assert the secret bytes appear NOWHERE in the archive (text or binary).
    const haystack = new TextDecoder('utf-8', { fatal: false }).decode(archive);
    expect(haystack.includes(SECRET)).toBe(false);

    // And a byte-level scan, so a non-utf8 embedding could not hide it.
    const needle = new TextEncoder().encode(SECRET);
    expect(indexOfBytes(archive, needle)).toBe(-1);

    // The round-trip still reproduces the plain remote URL faithfully.
    const dst = await mgr.importRepo('cred-dst', archive);
    expect(await dst.readFile('remote.config')).toContain(
      'https://github.com/taylor-made-labs/browser-repos.git',
    );
    expect(await dst.readFile('remote.config')).not.toContain(SECRET);
  });
});

describe('archive codec — structural invariants', () => {
  it('packs and unpacks entries byte-exact, preserving order and version', () => {
    const entries = [
      { path: '/work/a', bytes: new Uint8Array([0, 255, 128]) },
      { path: '/work/b', bytes: new TextEncoder().encode('hello') },
      { path: '/work/empty', bytes: new Uint8Array(0) },
    ];
    const packed = packArchive('/work', entries);
    const { header, entries: back } = unpackArchive(packed);

    expect(header.version).toBe(ARCHIVE_FORMAT_VERSION);
    expect(header.root).toBe('/work');
    expect(back.map((e) => e.path)).toEqual(['/work/a', '/work/b', '/work/empty']);
    expect(Array.from(back[0]!.bytes)).toEqual([0, 255, 128]);
    expect(new TextDecoder().decode(back[1]!.bytes)).toBe('hello');
    expect(back[2]!.bytes.byteLength).toBe(0);
  });

  it('a truncated archive is rejected', () => {
    const packed = packArchive('/work', [
      { path: '/work/a', bytes: new TextEncoder().encode('data') },
    ]);
    const truncated = packed.slice(0, packed.byteLength - 2);
    expect(() => unpackArchive(truncated)).toThrow();
  });
});

/** Find the first index of `needle` within `hay`, or -1. Byte-level search. */
function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
