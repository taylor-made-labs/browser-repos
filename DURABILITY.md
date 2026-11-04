# Durability — what holds, and what is only simulated

`browser-repos` stores every repository in IndexedDB through
`@isomorphic-git/lightning-fs`. Browser storage is not a reliable disk: it can
be evicted under quota pressure, a tab can be killed mid-write, and two parts of
an app can mutate the same repo at once. This document records, with evidence,
which durability properties the library **guarantees**, which it **surfaces**
rather than prevents, and which are **outside its control**. It is deliberately
honest about the last group — an awaited write is *not* assumed to be crash-safe.

The evidence is the test suite in [`test/durability.test.ts`](test/durability.test.ts),
cases (a)–(e) below. They run under Node with `fake-indexeddb`, pinned to the
same IndexedDB-mutex code path CI (Node 20) uses.

## Summary

| Property | Status | Evidence |
| --- | --- | --- |
| (a) Reopen keeps commits + branches + index | **Guaranteed** (IndexedDB persists) | case (a) |
| (b) Interrupted mutation → consistent, non-corrupt reopen | **Guaranteed for the library's own multi-step mutations**; single-transaction atomicity is IndexedDB's | case (b) |
| (c) Conflicting mutations do not corrupt / lose updates | **Guaranteed** via a per-repo lock + `runExclusive` | case (c) |
| (d) Quota exceeded | **Surfaced** as a distinct `QuotaExceededError` | case (d) |
| (e) Store lost/evicted | **Surfaced** as `StorageLostError`, never a silent empty answer | case (e) |

## (a) Reopen durability — holds

Create a repo, commit twice, add a branch, leave something staged; drop every
handle and build a fresh `RepoManager` against the same IndexedDB. The reopened
repo has the **same commit oids, newest-first history, the branch, and the
staged-but-uncommitted index entry**. This is the baseline IndexedDB gives us:
an awaited write that reached a committed IndexedDB transaction is there after a
reopen.

## (b) Simulated abrupt termination — consistent, never torn

**What we can simulate in Node:** the "the follow-up write never happened" shape
of a crash. `fake-indexeddb` only persists what an IndexedDB transaction
actually committed, so a mutation we never issued is simply absent on reopen. The
tests:

1. Commit value `A`, then "die" before the write that would produce `B` is ever
   issued → reopen reads a whole `A`, clean working tree, history `[A]`. Never a
   half-written `B`.
2. Commit a base, then write + stage a new file (those transactions commit) but
   "die" before the commit that would record them → reopen shows the base commit
   as the only history, the staged file present and marked `staged`, and the repo
   fully readable. The interrupted work is **recoverable** (just commit it now),
   not corrupt.

**What we CANNOT simulate in Node, and do not claim:** killing a real MV3 service
worker in the middle of an IndexedDB transaction (power loss during the browser's
own fsync). Whether a single IndexedDB transaction is all-or-nothing is the
**browser's** guarantee, not ours — IndexedDB transactions are atomic by spec, and
we rely on that. The library's own contribution is narrower and testable: it
never leaves *its own* multi-step mutation (write → stage → commit) half-applied
in a way a reopen observes as corrupt. A sequence that is interrupted leaves the
previous committed state intact plus, at most, a cleanly recoverable staged
change.

## (c) Conflicting mutations — serialized, no lost updates

The `.git` index and refs are shared files. Before this slice, two overlapping
`write → stage → commit` cycles on one repo **raced and silently dropped one
commit** — both calls resolved without error, yet history was missing a commit.
(That was confirmed with a throwaway probe before the fix.)

The fix is a **per-repo mutation queue** (`MutationQueue`), one per repo id,
shared by every handle the manager hands out for that id:

- Every individual mutating method (`writeFile`, `stage`, `commit`, `checkout`,
  …) runs through the queue, so same-repo mutations never interleave at the
  single-operation level. Different repos still run concurrently.
- For a **multi-step** mutation that must be atomic as a whole, use
  `repo.runExclusive(async (tx) => { … })`: it holds the repo lock for the entire
  callback, so two overlapping `write-stage-commit` cycles each land as a clean,
  separate commit instead of one finding "nothing staged".

Case (c) proves: two concurrent `runExclusive` cycles both commit (history has
all three commits, nothing lost); concurrent writes to the same path resolve to
one whole value, never a torn mix; and the queue runs FIFO and is not poisoned by
a rejected task.

> Reentrancy: a `runExclusive` callback must not call another `runExclusive` or a
> locking method on the same repo — it would wait on the lock it already holds.
> Use the lock-free `tx` steps the callback is given.

## (d) Quota exceeded — distinct typed error

When a write exceeds the browser's storage quota, IndexedDB throws a
`QuotaExceededError` `DOMException` (name `QuotaExceededError`, legacy code `22`).
The library detects it (`classifyStorageError` / `isQuotaExceeded`) and re-raises
a **distinct** `QuotaExceededError` (code `QUOTA_EXCEEDED`), separate from the
generic `StorageError` (`STORAGE_ERROR`) — because a caller's response differs:
quota is actionable (prune repos, request persistent storage), a generic fault
usually is not. The original DOMException is attached as `cause`. Case (d) forces
the throw via a fault-injecting backend and asserts the typed result, the
distinct code, and that the repo stays usable afterward.

## (e) Storage loss — surfaced, not silently wrong

A repo's IndexedDB store can be evicted or cleared while its id is still in the
registry. Reading such a repo naively would re-`git.init` an **empty** working
tree and return a confident wrong answer. Instead:

- `RepoManager.checkIntegrity()` probes every registered repo and reports each as
  `ok` or `lost`.
- `RepoManager.openRepoChecked(id)` throws `StorageLostError` (code
  `STORAGE_LOST`) for a lost store rather than handing back an empty repo.

**Simulation note:** loss is modelled at the backend port (a fresh handle reads
the namespace as empty) rather than via `indexedDB.deleteDatabase`, because
LightningFS caches its superblock in-process — deleting the on-disk database does
not evict the live in-memory view within one Node process, so it would not
actually simulate eviction. An empty fresh handle is exactly what the library
would see from a genuinely evicted store in the browser. Recovery is a re-import
from a slice-4 export.

## What this slice does *not* claim

- It does not make IndexedDB a durable disk. Eviction and quota are facts of the
  platform; the library **surfaces** them clearly instead of pretending they do
  not happen.
- It does not guarantee atomicity across a real browser process kill mid-
  transaction — that is IndexedDB's own transactional guarantee, which we depend
  on and do not re-implement.
- The storage backend was **not** changed. The honesty gate for this slice was:
  if LightningFS/IndexedDB turned out inadequate for a required property, stop
  and escalate rather than silently swap the store. It did not — every required
  property is either guaranteed or cleanly surfaced at the library layer.
