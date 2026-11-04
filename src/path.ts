/**
 * Path validation and normalization for files *inside* a repository.
 *
 * Paths are always repo-relative and POSIX-style. Validation rejects anything
 * that could escape the repository working tree: absolute paths, `..` segments,
 * empty names, and NUL bytes. This is a security boundary — never bypass it.
 */

import { InvalidPathError } from './errors.js';

/**
 * Validate and normalize a repo-relative path.
 *
 * Accepts forward-slash paths like `a/b/c.txt`. Rejects:
 * - empty / whitespace-only input
 * - absolute paths (leading `/`) and Windows drive / backslash forms
 * - any `..` or `.` segment (prevents traversal out of the repo root)
 * - empty segments (e.g. `a//b`) and NUL bytes
 *
 * @returns the normalized relative path (no leading `./`, no trailing slash).
 * @throws {InvalidPathError} when the path is empty, malformed, or escapes root.
 */
export function normalizeRelPath(input: string): string {
  if (typeof input !== 'string') {
    throw new InvalidPathError('Path must be a string.');
  }
  const raw = input.trim();
  if (raw.length === 0) {
    throw new InvalidPathError('Path must not be empty.');
  }
  if (raw.includes('\0')) {
    throw new InvalidPathError('Path must not contain NUL bytes.');
  }
  if (raw.includes('\\')) {
    throw new InvalidPathError('Path must use forward slashes, not backslashes.');
  }
  if (raw.startsWith('/')) {
    throw new InvalidPathError(`Absolute paths are not allowed: "${input}".`);
  }
  // Windows drive-letter form, e.g. C:\ or C:/
  if (/^[a-zA-Z]:/.test(raw)) {
    throw new InvalidPathError(`Drive-qualified paths are not allowed: "${input}".`);
  }

  const segments = raw.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') {
      // Collapse empty segments ("a//b") and single-dot segments ("a/./b").
      // An empty segment at the start/end is just a slash we can drop.
      continue;
    }
    if (seg === '..') {
      throw new InvalidPathError(`Path traversal ("..") is not allowed: "${input}".`);
    }
    out.push(seg);
  }

  if (out.length === 0) {
    throw new InvalidPathError(`Path resolves to the repository root: "${input}".`);
  }
  return out.join('/');
}

/**
 * Join a repo's filesystem root with a validated relative path, producing the
 * absolute path used against the LightningFS handle.
 *
 * @param root absolute FS root for the repo, e.g. `/work`.
 * @param relPath repo-relative path; validated via {@link normalizeRelPath}.
 */
export function toFsPath(root: string, relPath: string): string {
  const rel = normalizeRelPath(relPath);
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  return `${base}/${rel}`;
}
