/**
 * Lossless export / import for a {@link BrowserRepo}.
 *
 * This is the round-trip slice. `export` serializes the *entire* repository —
 * the whole `/work` subtree, which is the working tree **and** the complete
 * `.git` directory (all objects, every ref and branch, the full commit history,
 * and the index/staged state) **and** any untracked working-tree files — into a
 * single portable {@link Uint8Array}. `import` reconstructs a brand-new repo
 * whose filesystem is byte-for-byte identical, so it has the same files, same
 * bytes, same branches, same commit oids and history, same staged and untracked
 * state, and the same current branch.
 *
 * ### Why a whole-subtree copy is lossless
 *
 * Git's entire state — objects, refs, HEAD, config, and the staging index — is
 * just files under `.git`. The working tree is the files beside it. By copying
 * every byte of every file under `/work` and writing them back unchanged into a
 * fresh namespace, nothing is re-derived and nothing is lost: identical bytes in
 * `.git/objects` mean identical oids, identical `.git/refs` and `packed-refs`
 * mean identical branches, an identical `.git/index` means an identical staged
 * set, and files not tracked by git are copied because they are simply on disk.
 *
 * ### Security + credential-safety
 *
 * - Every entry path is validated on import before anything is written. A path
 *   that escapes the repo root (`..`, absolute, backslash/drive form, NUL byte)
 *   is rejected with a typed {@link ArchiveEntryRejectedError}; the partially
 *   built repo is rolled back so a rejected import leaves nothing behind.
 * - The archive contains only repo filesystem bytes. The library never reads,
 *   stores, or writes a credential, so an export is credential-free by
 *   construction — there is no code path that could place a token in it. Remote
 *   URLs, if a caller ever stored one in git config, travel as plain config
 *   with no embedded secret.
 *
 * Nothing here touches the network or evaluates code.
 */

import type { PromiseFs } from './fs-backend.js';
import {
  packArchive,
  unpackArchive,
  InvalidArchiveError as CodecInvalidArchiveError,
  MAX_ENTRY_BYTES,
  type ArchiveEntry,
} from './archive.js';
import { ArchiveEntryRejectedError, InvalidArchiveError, StorageError } from './errors.js';

/** The isomorphic-git `fs` shape (its `.promises` is a {@link PromiseFs}). */
type GitFs = { promises: PromiseFs };

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'EEXIST'
  );
}

/**
 * Export the full state of a repository rooted at `workDir` into one archive.
 * Walks the entire subtree (working tree + `.git` + untracked), capturing every
 * file byte-exact. Directory entries are recorded implicitly by their children;
 * an empty directory is captured with an explicit marker so it survives too.
 */
export async function exportRepo(fs: GitFs, workDir: string): Promise<Uint8Array> {
  const entries: ArchiveEntry[] = [];
  await walk(fs.promises, workDir, entries);
  // Deterministic order: sort by path so the same repo state exports to the
  // same bytes, which also makes the archive easy to reason about and diff.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return packArchive(workDir, entries);
}

/**
 * Marker suffix naming an archived empty directory, so zero-child directories
 * (e.g. a freshly-initialized `.git/hooks`) survive the round-trip. The suffix
 * is NUL-free so it passes path validation, and uses a reserved sentinel
 * segment that real repo files never carry. It encodes the directory whose
 * emptiness is being recorded: `<dir>/<SENTINEL>`.
 */
const EMPTY_DIR_SENTINEL = '__brepos_empty_dir__';
const EMPTY_DIR_MARKER = `/${EMPTY_DIR_SENTINEL}`;

/** Recursively collect every file under `dir` into `entries`. */
async function walk(promises: PromiseFs, dir: string, entries: ArchiveEntry[]): Promise<void> {
  let names: string[];
  try {
    names = await promises.readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return;
    throw new StorageError(`Failed to list "${dir}" during export.`, err);
  }

  if (names.length === 0) {
    entries.push({ path: `${dir}${EMPTY_DIR_MARKER}`, bytes: new Uint8Array(0) });
    return;
  }

  for (const name of names) {
    const child = `${dir}/${name}`;
    let isDir: boolean;
    try {
      const st = await promises.stat(child);
      isDir = st.isDirectory();
    } catch (err) {
      if (isEnoent(err)) continue; // race: entry vanished
      throw new StorageError(`Failed to stat "${child}" during export.`, err);
    }
    if (isDir) {
      await walk(promises, child, entries);
    } else {
      if (name === EMPTY_DIR_SENTINEL) {
        // A real file colliding with the reserved empty-dir sentinel would be
        // ambiguous on import. This name is not one git or a normal repo ever
        // produces; refuse rather than silently corrupt the round-trip.
        throw new StorageError(
          `Cannot export file "${child}": its name is reserved by the archive format.`,
        );
      }
      let bytes: Uint8Array;
      try {
        const out = await promises.readFile(child);
        bytes = typeof out === 'string' ? new TextEncoder().encode(out) : out;
      } catch (err) {
        if (isEnoent(err)) continue;
        throw new StorageError(`Failed to read "${child}" during export.`, err);
      }
      entries.push({ path: child, bytes });
    }
  }
}

/**
 * Validate one archived entry's path against the destination working directory.
 * The archive stores absolute repo-FS paths (e.g. `/work/.git/HEAD`); on import
 * we rebase each onto `destWorkDir` and reject anything that would escape it.
 *
 * Rejected: absolute paths that are not under the source root, any `..` or `.`
 * segment, backslashes, Windows drive forms, NUL bytes, and oversize entries.
 *
 * @returns the validated destination absolute path.
 * @throws {ArchiveEntryRejectedError}
 */
export function resolveImportPath(
  sourceRoot: string,
  destWorkDir: string,
  entryPath: string,
  size: number,
): string {
  const reject = (reason: string): never => {
    throw new ArchiveEntryRejectedError(`Rejected archive entry "${entryPath}": ${reason}.`);
  };

  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    reject('path is empty');
  }
  if (entryPath.includes('\0')) {
    reject('path contains a NUL byte');
  }
  if (entryPath.includes('\\')) {
    reject('path contains a backslash');
  }
  if (/^[a-zA-Z]:/.test(entryPath)) {
    reject('path is a drive-qualified Windows path');
  }
  if (size < 0 || size > MAX_ENTRY_BYTES) {
    reject(`entry size ${size} is out of range`);
  }

  // Strip an optional trailing empty-dir marker for path checking; the caller
  // handles the marker separately.
  const rawPath = entryPath.endsWith(EMPTY_DIR_MARKER)
    ? entryPath.slice(0, -EMPTY_DIR_MARKER.length)
    : entryPath;

  // Every exported path is absolute and begins with the source root.
  const srcBase = sourceRoot.endsWith('/') ? sourceRoot.slice(0, -1) : sourceRoot;
  if (rawPath !== srcBase && !rawPath.startsWith(`${srcBase}/`)) {
    reject(`path is outside the source root "${srcBase}"`);
  }

  const rel = rawPath === srcBase ? '' : rawPath.slice(srcBase.length + 1);
  for (const seg of rel.split('/')) {
    if (seg === '..') {
      reject('path contains a traversal segment ".."');
    }
    if (seg === '.') {
      reject('path contains a "." segment');
    }
  }

  const destBase = destWorkDir.endsWith('/') ? destWorkDir.slice(0, -1) : destWorkDir;
  return rel === '' ? destBase : `${destBase}/${rel}`;
}

/**
 * Reconstruct a repository from an archive into the (already created, empty)
 * filesystem rooted at `destWorkDir`. Validates every entry path first, then
 * writes each file byte-exact, creating parent directories as needed.
 *
 * On any rejected entry the whole import is aborted and `destWorkDir` is wiped,
 * so a failed import never leaves a half-built repo.
 *
 * @throws {InvalidArchiveError} if the archive itself is malformed.
 * @throws {ArchiveEntryRejectedError} if any entry fails validation.
 */
export async function importRepo(
  fs: GitFs,
  destWorkDir: string,
  archive: Uint8Array,
): Promise<void> {
  let header: ReturnType<typeof unpackArchive>['header'];
  let entries: ArchiveEntry[];
  try {
    const unpacked = unpackArchive(archive);
    header = unpacked.header;
    entries = unpacked.entries;
  } catch (err) {
    if (err instanceof CodecInvalidArchiveError) {
      throw new InvalidArchiveError(err.message, err);
    }
    throw new InvalidArchiveError('Failed to read archive.', err);
  }

  const sourceRoot = header.root;

  // Validate *all* paths up front, before writing anything, so a hostile entry
  // cannot have a side effect before the one that is rejected.
  const planned: Array<{ dest: string; bytes: Uint8Array; isEmptyDirMarker: boolean }> = [];
  for (const e of entries) {
    const isEmptyDirMarker = e.path.endsWith(EMPTY_DIR_MARKER);
    const dest = resolveImportPath(sourceRoot, destWorkDir, e.path, e.bytes.byteLength);
    planned.push({ dest, bytes: e.bytes, isEmptyDirMarker });
  }

  try {
    await ensureDir(fs.promises, destWorkDir);
    for (const item of planned) {
      if (item.isEmptyDirMarker) {
        await ensureDir(fs.promises, item.dest);
        continue;
      }
      await ensureParentDirs(fs.promises, item.dest);
      try {
        await fs.promises.writeFile(item.dest, item.bytes);
      } catch (err) {
        throw new StorageError(`Failed to write "${item.dest}" during import.`, err);
      }
    }
  } catch (err) {
    // Roll back a partial import so a failure leaves no repo behind.
    await wipeTree(fs.promises, destWorkDir).catch(() => undefined);
    throw err;
  }
}

/** Create a directory (and ancestors) if missing. Idempotent. */
async function ensureDir(promises: PromiseFs, dir: string): Promise<void> {
  const parts = dir.split('/').filter((p) => p.length > 0);
  let cur = '';
  for (const part of parts) {
    cur = `${cur}/${part}`;
    try {
      await promises.mkdir(cur);
    } catch (err) {
      if (!isEexist(err)) {
        throw new StorageError(`Failed to create directory "${cur}" during import.`, err);
      }
    }
  }
}

/** Create every parent directory of an absolute file path. */
async function ensureParentDirs(promises: PromiseFs, absPath: string): Promise<void> {
  const idx = absPath.lastIndexOf('/');
  if (idx <= 0) return;
  await ensureDir(promises, absPath.slice(0, idx));
}

/** Recursively empty a subtree (used to roll back a failed import). */
async function wipeTree(promises: PromiseFs, root: string): Promise<void> {
  let names: string[];
  try {
    names = await promises.readdir(root);
  } catch (err) {
    if (isEnoent(err)) return;
    throw new StorageError(`Failed to list "${root}" during rollback.`, err);
  }
  for (const name of names) {
    const child = `${root}/${name}`;
    let isDir = false;
    try {
      const st = await promises.stat(child);
      isDir = st.isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      await wipeTree(promises, child);
      try {
        await promises.rmdir(child);
      } catch (err) {
        if (!isEnoent(err)) throw new StorageError(`Failed to remove "${child}".`, err);
      }
    } else {
      try {
        await promises.unlink(child);
      } catch (err) {
        if (!isEnoent(err)) throw new StorageError(`Failed to remove "${child}".`, err);
      }
    }
  }
}
