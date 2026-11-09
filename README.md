# browser-repos

> Kiroween 2026 — **Skeleton Crew** entry. An independent, open-source,
> Git-compatible **repository library for the browser**: real Git semantics
> backed by **IndexedDB**, with no server and no native Git required.

`browser-repos` gives the browser a real, multi-repo Git engine. You create
repositories, write files, stage and commit, branch and switch, inspect history,
and export or import a whole repo byte-for-byte — all **offline**, all persisted
in IndexedDB, with a **typed error for everything that can go wrong**.

The **core is free of UI, LLM calls, and app logic**, so it is reusable outside
this product. It is built to run inside a browser extension **Manifest V3 (MV3)**
service worker: dependencies are **bundled locally** — no runtime CDN code and
no `eval`.

> **Storage is not a backup.** IndexedDB can be evicted by the browser at any
> time. Treat a repo as a cache, not durable storage, and keep exports.
> See [Durability](#durability).

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [How it works](#how-it-works)
- [Public API reference](#public-api-reference)
- [Error taxonomy](#error-taxonomy)
- [Durability](#durability)
- [MV3 and offline notes](#mv3-and-offline-notes)
- [Hard boundaries](#hard-boundaries)
- [License](#license)

## Install

```bash
npm install @taylor-made-labs/browser-repos
```

Runtime dependencies ([isomorphic-git](https://github.com/isomorphic-git/isomorphic-git)
and [LightningFS](https://github.com/isomorphic-git/lightning-fs)) are pinned and
ship with the package. There is no peer dependency and nothing is fetched from a
CDN at runtime.

**Requirements:** an environment with IndexedDB (a browser, or Node with a
spec-compliant IndexedDB shim such as `fake-indexeddb` for tests).

## Quickstart

Create a repo, write a file, commit it, branch, then export and re-import it — all
through the single package entry point.

```ts
import { RepoManager } from '@taylor-made-labs/browser-repos';

// One manager per app. It persists the set of repos across sessions.
const manager = new RepoManager();

// 1. Create a repository (its own IndexedDB namespace).
const repo = await manager.createRepo('notes');

// 2. Write files (repo-relative paths; parent dirs are created for you).
await repo.writeFile('README.md', '# My notes\n');
await repo.writeFile('ideas/first.md', 'hello world\n');

// 3. Stage and commit. The author is plain metadata — never a credential.
await repo.stage('README.md');
await repo.stage('ideas/first.md');
const oid = await repo.commit({
  message: 'Initial commit',
  author: { name: 'Ada Lovelace', email: 'ada@example.com' },
});

// 4. Branch and switch. The working tree is rewritten to match the branch.
await repo.createBranch('draft', { checkout: true });
await repo.writeFile('ideas/second.md', 'draft-only\n');
await repo.stage('ideas/second.md');
await repo.commit({ message: 'Add a draft', author: { name: 'Ada', email: 'ada@example.com' } });

await repo.checkout('main'); // ideas/second.md is gone from the working tree here
await repo.checkout('draft'); // ...and back again

// 5. Export the whole repo (working tree + full .git + staged + untracked).
const archive = await repo.export();

// 6. Import it into a fresh repo — byte-for-byte identical.
const restored = await manager.importRepo('notes-copy', archive);
console.log(await restored.readFile('README.md')); // "# My notes\n"
```

Everything above is local and offline. No network call is made at any point.

## How it works

A pure-JavaScript Git engine (isomorphic-git) runs over an IndexedDB-backed
filesystem (LightningFS). Each repository lives in its own IndexedDB namespace,
so repos never collide, and the set of known repos is persisted in a separate
registry — so the repo list, like the repos themselves, survives close and
reopen.

- **`RepoManager`** owns the set of repositories: create, open, list, delete,
  import, and integrity-check.
- **`BrowserRepo`** is a handle to one open repository: file ops, git ops,
  branches, export, and a `runExclusive` transaction for multi-step atomic
  mutations.

Every mutation on a repo is serialized through a per-repo queue, so two
overlapping write-stage-commit cycles cannot race on the shared `.git` index and
silently drop a commit.

## Public API reference

Import **only** from the package entry. Reaching into internal module paths is
unsupported and may break between versions.

```ts
import {
  RepoManager, BrowserRepo, VERSION,
  // ...types and error classes, below
} from '@taylor-made-labs/browser-repos';
```

### Entry point

| Export | Kind | Purpose |
|---|---|---|
| `RepoManager` | class | Create and manage multiple repositories. |
| `BrowserRepo` | class | Handle to one open repository. |
| `VERSION` | const | Library semantic version string. |

### `RepoManager`

| Member | Signature | Purpose |
|---|---|---|
| constructor | `new RepoManager(options?: RepoManagerOptions)` | One per app. `options.backendFactory` is injectable for tests. |
| `createRepo` | `(id) => Promise<BrowserRepo>` | Create and init a new repo. Throws `RepoExistsError`. |
| `openRepo` | `(id) => Promise<BrowserRepo>` | Open an existing repo. Throws `RepoNotFoundError`. |
| `openRepoChecked` | `(id) => Promise<BrowserRepo>` | Open, but throw `StorageLostError` if the store was lost. |
| `importRepo` | `(id, archive) => Promise<BrowserRepo>` | Reconstruct a repo from an export. |
| `listRepos` | `() => Promise<RepoInfo[]>` | List known repos (persisted). |
| `hasRepo` | `(id) => Promise<boolean>` | Whether a repo id exists. |
| `deleteRepo` | `(id) => Promise<void>` | Remove a repo and wipe its data. |
| `checkIntegrity` | `() => Promise<IntegrityReport>` | Report which repos have lost their backing store. |

### `BrowserRepo`

| Group | Members |
|---|---|
| Identity | `id`, `namespace` |
| Files | `writeFile`, `readFile`, `readFileBytes`, `exists`, `listFiles`, `deleteFile` |
| Git | `status`, `statusOf`, `stage`, `stageRemoval`, `unstage`, `commit`, `log` |
| Branches | `currentBranch`, `listBranches`, `hasBranch`, `createBranch`, `checkout`, `deleteBranch` |
| Export/import | `export` (import lives on `RepoManager.importRepo`) |
| Transactions | `runExclusive((tx) => ...)` — run a multi-step mutation atomically |

### Public types

Options and result shapes, all exported from the entry point:

`RepoManagerOptions`, `RepoInfo`, `RepoIntegrity`, `IntegrityReport`,
`DirEntry`, `RepoTransaction`, `FileStatus`, `FileStatusEntry`, `StatusReport`,
`CommitAuthor`, `CommitOptions`, `CommitEntry`, `LogOptions`,
`CreateBranchOptions`, `ArchiveEntry`, `ArchiveHeader`, `StorageErrorKind`,
`FsBackend`, `FsBackendFactory`, `PromiseFs`, `BrowserReposErrorCode`.

### Lower-level helpers

Exported for advanced adopters who need the building blocks: `GitOps`,
`BranchOps`, `assertValidBranchName`, `exportRepo`, `importRepo`,
`resolveImportPath`, `packArchive`, `unpackArchive`, `normalizeRelPath`,
`lightningFsBackendFactory`, `MutationQueue`, `MutationQueueRegistry`,
`isQuotaExceeded`, `classifyStorageError`, and the archive constants
(`ARCHIVE_FORMAT_VERSION`, `MAX_ENTRY_BYTES`, `MAX_ENTRIES`). Most apps only
need `RepoManager` and `BrowserRepo`.

## Error taxonomy

Every error the library throws is a subclass of **`BrowserReposError`** and
carries a stable, machine-readable **`code`**. Catch the base to handle anything,
or catch a specific subclass to handle one case:

```ts
import { BrowserReposError, QuotaExceededError } from '@taylor-made-labs/browser-repos';

try {
  await repo.writeFile('big.bin', hugeBytes);
} catch (err) {
  if (err instanceof QuotaExceededError) {
    // actionable: free space, prune repos, request persistent storage
  } else if (err instanceof BrowserReposError) {
    console.error(err.code, err.message); // branch on err.code if you prefer
  } else {
    throw err;
  }
}
```

### Local errors

| Error | `code` | Thrown when | How to handle |
|---|---|---|---|
| `InvalidRepoIdError` | `INVALID_REPO_ID` | A repo id is empty, malformed, or contains `..`. | Fix the id. |
| `RepoExistsError` | `REPO_EXISTS` | Creating/importing an id that already exists. | Pick a new id or open the existing one. |
| `RepoNotFoundError` | `REPO_NOT_FOUND` | Opening/deleting an unknown id. | Create it, or list repos first. |
| `InvalidPathError` | `INVALID_PATH` | A file path is empty, absolute, or escapes the repo root. | Use a repo-relative path. |
| `NotFoundError` | `NOT_FOUND` | Reading/deleting a path that does not exist. | Check `exists()` first. |
| `NothingStagedError` | `NOTHING_STAGED` | Committing with an empty index. | Stage changes before committing. |
| `InvalidBranchNameError` | `INVALID_BRANCH_NAME` | A branch name violates git ref rules. | Use a valid branch name. |
| `BranchNotFoundError` | `BRANCH_NOT_FOUND` | Checking out / deleting an unknown branch. | List branches first. |
| `BranchInUseError` | `BRANCH_IN_USE` | Deleting the current branch. | Switch away first. |
| `UncommittedChangesError` | `UNCOMMITTED_CHANGES` | Checkout with uncommitted tracked changes. | Commit or discard, then retry. |
| `InvalidArchiveError` | `INVALID_ARCHIVE` | An import archive is malformed/truncated/wrong version. | Re-export; do not hand-edit archives. |
| `ArchiveEntryRejectedError` | `ARCHIVE_ENTRY_REJECTED` | An archive entry escapes the root or is oversized. | Treat the archive as untrusted/corrupt. |
| `QuotaExceededError` | `QUOTA_EXCEEDED` | A write exceeds the browser storage quota. | Free space, prune, request persistent storage. |
| `StorageLostError` | `STORAGE_LOST` | A registered repo's store was evicted/cleared. | Recover from an export. |
| `StorageError` | `STORAGE_ERROR` | An underlying IndexedDB/filesystem op failed. | Usually unrecoverable; surface to the user. |

### Remote / sync errors (contract available now; network ops land in a later slice)

These classes are **defined and exported today** so you can write `catch`
handlers for the full contract up front. The operations that *throw* them (push,
pull, clone against a remote) ship in a later slice — **this release contains no
network code**. Each is constructable, `instanceof BrowserReposError`, and
carries a distinct `code`/`name`.

| Error | `code` | Thrown when (future) | How to handle |
|---|---|---|---|
| `NetworkError` | `NETWORK_ERROR` | Offline, DNS failure, timeout, reset — no response. | Retry, or fall back to offline mode. |
| `CorsError` | `CORS_ERROR` | The browser blocked the response on cross-origin policy. | Fix remote CORS config or use a proxy. |
| `AuthError` | `AUTH_ERROR` | The remote rejected the credential (401/403). | Prompt for re-authentication. |
| `DivergenceError` | `DIVERGENCE_ERROR` | Local and remote history diverged (no fast-forward). | Offer pull-then-merge, rebase, or force. |
| `ConflictError` | `CONFLICT_ERROR` | A merge produced conflicting edits. | Resolve conflicts, then continue. |

## Durability

**IndexedDB is not a backup.** The browser may evict a repo's store under
storage pressure, on a cleared profile, or on a storage reset. The library makes
loss *detectable and distinct* rather than silent:

- Writes that exceed quota throw `QuotaExceededError` (distinct from a generic
  `StorageError`), so you can react — free space, prune repos, or request
  persistent storage.
- `RepoManager.checkIntegrity()` and `openRepoChecked()` surface a lost store as
  `StorageLostError` instead of reading it as an empty-but-valid repo.
- `BrowserRepo.export()` produces a portable, byte-exact archive; re-import it to
  recover. **Exporting regularly is the only real backup.**

Full detail, including the mutation-serialization model, is in
[`DURABILITY.md`](DURABILITY.md).

## MV3 and offline notes

- **MV3-compatible:** executable dependencies are bundled; there is no runtime
  CDN load and no `eval`, so the library runs inside a Manifest V3 service
  worker.
- **IndexedDB only:** the library never uses `localStorage` or `chrome.storage`.
- **Offline-first:** every operation in this release is local. Nothing reaches
  the network.

## Hard boundaries

- **Core is UI/LLM/app-free** — it never imports a UI framework, calls a model,
  or embeds product logic.
- **Secrets are never persisted** — credentials come from caller hooks and are
  never written to repo data, remote URLs, exports, commits, or logs. An export
  is credential-free by construction.

## License

Dual-licensed under either **MIT** ([LICENSE-MIT](LICENSE-MIT)) or **Apache-2.0**
([LICENSE-APACHE](LICENSE-APACHE)), at your option. Third-party and upstream
attributions are in [NOTICE](NOTICE).

## Kiro and Kiroween 2026

Built with [Kiro](https://kiro.dev) using a spec-driven workflow for Kiroween
2026. Specs, steering, and development evidence live in the public
[`.kiro/`](.kiro/) directory.
