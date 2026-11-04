/**
 * Error-taxonomy test (slice 6).
 *
 * Proves the typed error contract an adopter relies on:
 *  - every error class is exported from the package entry point;
 *  - every subclass is `instanceof BrowserReposError` (catch-the-base works);
 *  - each subclass is distinctly catchable and carries a distinct `code`/`name`
 *    (no two share a code);
 *  - the remote/sync family (Network/Cors/Auth/Divergence/Conflict) exists, is
 *    constructable, and is exported, even though no network op ships this slice.
 */
import { describe, expect, it } from 'vitest';
import {
  BrowserReposError,
  // local family
  InvalidRepoIdError,
  RepoExistsError,
  RepoNotFoundError,
  InvalidPathError,
  NotFoundError,
  NothingStagedError,
  InvalidBranchNameError,
  BranchNotFoundError,
  BranchInUseError,
  UncommittedChangesError,
  InvalidArchiveError,
  ArchiveEntryRejectedError,
  QuotaExceededError,
  StorageLostError,
  StorageError,
  // remote / sync family
  NetworkError,
  CorsError,
  AuthError,
  DivergenceError,
  ConflictError,
} from '../src/index.js';

/** One constructed instance of every error, with the code it must carry. */
const instances: Array<{ name: string; err: BrowserReposError; code: string }> = [
  { name: 'InvalidRepoIdError', err: new InvalidRepoIdError('x'), code: 'INVALID_REPO_ID' },
  { name: 'RepoExistsError', err: new RepoExistsError('x'), code: 'REPO_EXISTS' },
  { name: 'RepoNotFoundError', err: new RepoNotFoundError('x'), code: 'REPO_NOT_FOUND' },
  { name: 'InvalidPathError', err: new InvalidPathError('x'), code: 'INVALID_PATH' },
  { name: 'NotFoundError', err: new NotFoundError('x'), code: 'NOT_FOUND' },
  { name: 'NothingStagedError', err: new NothingStagedError(), code: 'NOTHING_STAGED' },
  { name: 'InvalidBranchNameError', err: new InvalidBranchNameError('x'), code: 'INVALID_BRANCH_NAME' },
  { name: 'BranchNotFoundError', err: new BranchNotFoundError('x'), code: 'BRANCH_NOT_FOUND' },
  { name: 'BranchInUseError', err: new BranchInUseError('x'), code: 'BRANCH_IN_USE' },
  { name: 'UncommittedChangesError', err: new UncommittedChangesError('x'), code: 'UNCOMMITTED_CHANGES' },
  { name: 'InvalidArchiveError', err: new InvalidArchiveError('x'), code: 'INVALID_ARCHIVE' },
  { name: 'ArchiveEntryRejectedError', err: new ArchiveEntryRejectedError('x'), code: 'ARCHIVE_ENTRY_REJECTED' },
  { name: 'QuotaExceededError', err: new QuotaExceededError('x'), code: 'QUOTA_EXCEEDED' },
  { name: 'StorageLostError', err: new StorageLostError('x'), code: 'STORAGE_LOST' },
  { name: 'StorageError', err: new StorageError('x'), code: 'STORAGE_ERROR' },
  { name: 'NetworkError', err: new NetworkError('x'), code: 'NETWORK_ERROR' },
  { name: 'CorsError', err: new CorsError('x'), code: 'CORS_ERROR' },
  { name: 'AuthError', err: new AuthError('x'), code: 'AUTH_ERROR' },
  { name: 'DivergenceError', err: new DivergenceError('x'), code: 'DIVERGENCE_ERROR' },
  { name: 'ConflictError', err: new ConflictError('x'), code: 'CONFLICT_ERROR' },
];

describe('error taxonomy — base class and discriminators', () => {
  it('every subclass is an instanceof BrowserReposError and a real Error', () => {
    for (const { name, err } of instances) {
      expect(err, name).toBeInstanceOf(BrowserReposError);
      expect(err, name).toBeInstanceOf(Error);
    }
  });

  it('every subclass carries its expected, distinct code and a matching name', () => {
    for (const { name, err, code } of instances) {
      expect(err.code, name).toBe(code);
      expect(err.name, name).toBe(name);
    }
  });

  it('no two error classes share a code (every code is distinct)', () => {
    const codes = instances.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('a subclass is distinctly catchable without catching a sibling', () => {
    // QuotaExceededError must not be caught as a NotFoundError, and vice-versa.
    const quota = new QuotaExceededError('full');
    expect(quota instanceof NotFoundError).toBe(false);
    expect(quota instanceof QuotaExceededError).toBe(true);

    const notFound = new NotFoundError('gone');
    expect(notFound instanceof QuotaExceededError).toBe(false);
    expect(notFound instanceof NotFoundError).toBe(true);
  });
});

describe('error taxonomy — remote / sync family (contract present, no network code)', () => {
  const remote = [
    { name: 'NetworkError', err: new NetworkError('offline'), code: 'NETWORK_ERROR' },
    { name: 'CorsError', err: new CorsError('blocked'), code: 'CORS_ERROR' },
    { name: 'AuthError', err: new AuthError('401'), code: 'AUTH_ERROR' },
    { name: 'DivergenceError', err: new DivergenceError('diverged'), code: 'DIVERGENCE_ERROR' },
    { name: 'ConflictError', err: new ConflictError('conflict'), code: 'CONFLICT_ERROR' },
  ];

  it('each remote error is constructable, distinct, and instanceof the base', () => {
    const seen = new Set<string>();
    for (const { name, err, code } of remote) {
      expect(err, name).toBeInstanceOf(BrowserReposError);
      expect(err.code, name).toBe(code);
      expect(err.name, name).toBe(name);
      seen.add(err.code);
    }
    expect(seen.size).toBe(remote.length); // all distinct
  });

  it('carries a cause when given one', () => {
    const cause = new TypeError('failed to fetch');
    const net = new NetworkError('offline', cause);
    expect(net.cause).toBe(cause);
  });

  it('each remote family member is distinctly catchable from the others', () => {
    const divergence = new DivergenceError('history moved on both sides');
    expect(divergence instanceof ConflictError).toBe(false);
    expect(divergence instanceof DivergenceError).toBe(true);
  });
});
