---
inclusion: always
---

# browser-repos — project & scope

## What this repo is

`browser-repos` is an **independent, open-source, Git-compatible repository library for the
browser**: real Git semantics over an **IndexedDB**-backed filesystem, with no server and no
native Git. It is repo **2 of 5** in the Kiroween 2026 **Skeleton Crew** project, but it is
designed to be **reusable outside** that product.

## Scope boundaries (non-negotiable)

- **Core is free of UI, LLM calls, and app logic.** It never imports a UI framework, calls a
  model, or embeds product-specific logic. Anything app-specific lives in the consuming repo.
- **IndexedDB only** — never `localStorage`, never `chrome.storage`.
- **Manifest V3 compatible** — executable dependencies are **bundled locally**: no runtime
  CDN code, no `eval`.
- **Offline-first** — local operations work without a server or native Git. Network
  operations happen only on an explicit caller request; any CORS proxy is explicitly
  configured by the caller.
- **Secrets never persisted** — credentials come from caller hooks and are never written to
  repo data, remote URLs, exports, commits, or logs.

## Planned capability surface

Multiple repos, reopen, file read/write, status, staging, commits, branches/checkouts,
history, and lossless export/import (working tree, `.git`, binaries, staged + untracked,
branches, history) with path and archive-entry validation.

## Dependencies (pinned, bundled)

Expected core dependencies are **isomorphic-git** (pure-JS Git) and
**@isomorphic-git/lightning-fs** (IndexedDB filesystem). They are added at **pinned exact
versions**, bundled for MV3, and recorded in [`NOTICE`](../../NOTICE) when included.

## Verification

The dev sandbox has no public network, so `npm install` cannot reach the registry here.
Author and commit locally; **GitHub Actions CI is the source of truth** for "it builds and
tests pass" (`npm ci` → typecheck → lint → test → build).

## `.kiro` is public

`.kiro/` is **tracked and never gitignored** — judges must read specs, steering, and
development evidence in a fresh clone (hackathon requirement).
