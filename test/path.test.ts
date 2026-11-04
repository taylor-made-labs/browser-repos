import { describe, expect, it } from 'vitest';
import { normalizeRelPath } from '../src/path.js';
import { InvalidPathError } from '../src/errors.js';

describe('normalizeRelPath — valid paths', () => {
  it('accepts a simple file name', () => {
    expect(normalizeRelPath('README.md')).toBe('README.md');
  });

  it('accepts a valid nested path (required invariant)', () => {
    expect(normalizeRelPath('src/components/Button.tsx')).toBe('src/components/Button.tsx');
  });

  it('collapses "./" and redundant slashes', () => {
    expect(normalizeRelPath('./a//b/c.txt')).toBe('a/b/c.txt');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeRelPath('  dir/file.txt  ')).toBe('dir/file.txt');
  });
});

describe('normalizeRelPath — rejected paths (traversal + escapes)', () => {
  it('rejects a parent-traversal attempt (required invariant)', () => {
    expect(() => normalizeRelPath('../secrets.txt')).toThrow(InvalidPathError);
  });

  it('rejects traversal buried in the middle of a path', () => {
    expect(() => normalizeRelPath('a/b/../../../etc/passwd')).toThrow(InvalidPathError);
  });

  it('rejects an absolute path', () => {
    expect(() => normalizeRelPath('/etc/passwd')).toThrow(InvalidPathError);
  });

  it('rejects a Windows drive path', () => {
    expect(() => normalizeRelPath('C:\\Windows\\system32')).toThrow(InvalidPathError);
  });

  it('rejects backslashes', () => {
    expect(() => normalizeRelPath('a\\b')).toThrow(InvalidPathError);
  });

  it('rejects an empty path', () => {
    expect(() => normalizeRelPath('')).toThrow(InvalidPathError);
    expect(() => normalizeRelPath('   ')).toThrow(InvalidPathError);
  });

  it('rejects a path that resolves to root', () => {
    expect(() => normalizeRelPath('.')).toThrow(InvalidPathError);
    expect(() => normalizeRelPath('./')).toThrow(InvalidPathError);
  });

  it('rejects NUL bytes', () => {
    expect(() => normalizeRelPath('a\0b')).toThrow(InvalidPathError);
  });

  it('carries the INVALID_PATH code on the thrown error', () => {
    try {
      normalizeRelPath('../x');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidPathError);
      expect((err as InvalidPathError).code).toBe('INVALID_PATH');
    }
  });
});
