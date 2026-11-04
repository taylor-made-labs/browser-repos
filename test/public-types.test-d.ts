/**
 * Type-level check (slice 6) — compile-time only.
 *
 * This file is NOT run by vitest (its `include` is `test/**\/*.test.ts`); it is
 * compiled by `npm run typecheck`, whose tsconfig includes `test/`. Its job is
 * to prove the EXPORTED public types are usable by an outside adopter purely
 * through the package entry point: you can annotate values with them, build the
 * option/result shapes, consume the handle types, and implement the backend
 * port — without ever importing an internal module.
 *
 * If a public type were dropped from the entry point, or its shape changed in a
 * breaking way, this file would fail `npm run typecheck`, catching the
 * regression before it reaches an adopter.
 */
import {
  RepoManager,
  type BrowserRepo,
  type RepoManagerOptions,
  type RepoInfo,
  type RepoIntegrity,
  type IntegrityReport,
  type DirEntry,
  type RepoTransaction,
  type FileStatus,
  type FileStatusEntry,
  type StatusReport,
  type CommitAuthor,
  type CommitOptions,
  type CommitEntry,
  type LogOptions,
  type CreateBranchOptions,
  type ArchiveEntry,
  type ArchiveHeader,
  type StorageErrorKind,
  type FsBackend,
  type FsBackendFactory,
  type PromiseFs,
  type BrowserReposErrorCode,
} from '../src/index.js';

// --- Compile-time assertion helpers ----------------------------------------
// If the condition is not `true`, the alias fails to compile.
type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

// --- 1. Option shapes are constructable by an adopter -----------------------

const managerOptions: RepoManagerOptions = {}; // all fields optional
const author: CommitAuthor = { name: 'Ada', email: 'ada@example.com' };
const commitOptions: CommitOptions = { message: 'msg', author };
const committerOptions: CommitOptions = { message: 'msg', author, committer: author };
const logOptions: LogOptions = { depth: 10 };
const emptyLogOptions: LogOptions = {}; // depth optional
const branchFromHead: CreateBranchOptions = {};
const branchFromRef: CreateBranchOptions = { from: 'main', checkout: true };

// --- 2. Result shapes an adopter reads --------------------------------------

const repoInfo: RepoInfo = { id: 'x', namespace: 'ns' };
const integrity: RepoIntegrity = { id: 'x', status: 'ok' };
const report: IntegrityReport = { healthy: true, repos: [integrity] };
const dirEntry: DirEntry = { name: 'README.md', isDirectory: false };
const statusEntry: FileStatusEntry = { path: 'a.ts', status: 'modified' };
const statusReport: StatusReport = { clean: false, files: [statusEntry] };
const commitEntry: CommitEntry = {
  oid: 'deadbeef',
  message: 'm',
  author,
  timestamp: 0,
  parents: [],
};

// --- 3. Union + enum-like public types resolve to their members -------------

const fileStatus: FileStatus = 'staged';
const storageKind: StorageErrorKind | undefined = undefined;
const errCode: BrowserReposErrorCode = 'NETWORK_ERROR'; // remote code is in the union
const archiveEntryShape: Pick<ArchiveEntry, 'path'> = { path: '/work/README.md' };

// --- 4. A function typed entirely from public exports -----------------------

export async function adopterFlow(
  factory: FsBackendFactory,
  opts: RepoManagerOptions,
): Promise<{ repo: BrowserRepo; info: RepoInfo[] }> {
  const manager = new RepoManager({ ...opts, backendFactory: factory });
  const repo: BrowserRepo = await manager.createRepo('demo');
  const info: RepoInfo[] = await manager.listRepos();
  await repo.runExclusive(async (tx: RepoTransaction) => {
    await tx.writeFile('f.txt', 'hi'); // the transaction API type is public
  });
  return { repo, info };
}

// --- 5. Relationships the port contract guarantees --------------------------

export type _TypeChecks = [
  Assert<Extends<FsBackendFactory, (ns: string) => FsBackend>>,
  Assert<Extends<FsBackend['promises'], PromiseFs>>,
  Assert<Extends<ArchiveHeader, ArchiveHeader>>,
];

// Re-export the annotated constants so `verbatimModuleSyntax`/no-unused rules do
// not flag them; referencing them here is enough to force the checks above.
export const _publicTypeValues = {
  managerOptions,
  commitOptions,
  committerOptions,
  logOptions,
  emptyLogOptions,
  branchFromHead,
  branchFromRef,
  repoInfo,
  report,
  dirEntry,
  statusReport,
  commitEntry,
  fileStatus,
  storageKind,
  errCode,
  archiveEntryShape,
};
