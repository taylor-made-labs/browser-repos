# Specs: browser-repos

Spec-driven development for this library lives here.

**Status (2026-11-09): retroactive record.** The library was built in seven slices, each
landed as a pull request with tests. Full requirements/design/tasks triads were **not**
written per slice before building; this file records what shipped and where the evidence is,
so the specs match the code. Treat the steering files in `../steering/` as the binding
scope, and the tests as the executable spec.

## What shipped

| Slice | PR | Capability | Evidence (tests) |
|---|---|---|---|
| 1 | #2 | Repo lifecycle: create, open, list, delete, reopen, many repos, path validation | `test/repo-lifecycle.test.ts`, `test/path.test.ts` |
| 2 | #3 | Offline git: status, stage, unstage, commit, log | `test/git-ops.test.ts` |
| 3 | #4 | Branches: create, list, delete, checkout, working-tree isolation | `test/branch-ops.test.ts` |
| 4 | #5 | Lossless export/import with archive-entry validation | `test/export-import.test.ts` |
| 5 | #6 | Durability: per-repo mutation queue, quota and storage-loss errors | `test/durability.test.ts`, `DURABILITY.md` |
| 6 | #7 | Public API surface, README, full error taxonomy | `test/public-surface.test.ts`, `test/public-types.test-d.ts`, `test/error-taxonomy.test.ts` |
| 7 | #8 | Optional `RemoteSyncTarget` port and GitHub adapter | `test/remote-sync.test.ts`; `test/remote-sync.live.test.ts` is skipped unless run live |
| docs | n/a | MV3 static and runtime evidence | `test/mv3-compat.test.ts`, `docs/mv3-compat.md` |

Dependencies, pinned: `isomorphic-git` 1.44.10, `@isomorphic-git/lightning-fs` 4.10.5.

## Known gaps

- No real-browser or real-extension test; IndexedDB is `fake-indexeddb` under Node.
- The live remote-sync test has not been run in CI.
- If a capability changes, write its `requirements.md`, `design.md`, `tasks.md` triad in
  `.kiro/specs/<capability>/` before building.
