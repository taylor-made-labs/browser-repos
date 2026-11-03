# browser-repos

> Kiroween 2026 — **Skeleton Crew** entry. An independent, open-source, Git-compatible
> **repository library for the browser**: real Git semantics backed by **IndexedDB**, with
> no server and no native Git required.

`browser-repos` is a reusable library. Its **core is free of UI, LLM calls, and app logic**,
so it can be used outside this product. It is built to work inside a browser extension
**Manifest V3 (MV3)** service worker: dependencies are **bundled locally** — no runtime CDN
code and no `eval`.

**Status:** early scaffolding. This README documents intent and the architecture we are
building toward; everything marked _(planned)_ is not yet implemented. We do not overstate
reliability — browser storage is not a backup (see [Limitations](#limitations)).

## What it is

A pure-JavaScript Git engine ([isomorphic-git](https://github.com/isomorphic-git/isomorphic-git),
_planned dependency_) running over an IndexedDB-backed filesystem
([LightningFS](https://github.com/isomorphic-git/lightning-fs), _planned dependency_). Local
operations work **offline**; network operations happen only on an explicit caller request.

### Scope _(planned)_

- Multiple repositories; reopen across sessions.
- File read/write, status, staging, commits, branches/checkouts, history.
- Lossless export/import (working tree, `.git`, binaries, staged + untracked, branches,
  history), with path and archive-entry validation.

### Hard boundaries

- **Core is UI/LLM/app-free** — it never imports a UI framework, calls a model, or embeds
  product logic.
- **IndexedDB only** — never `localStorage`, never `chrome.storage`.
- **MV3-compatible** — executable dependencies are bundled; no runtime CDN, no `eval`.
- **Secrets never persisted** — credentials come from caller hooks and are never written to
  repo data, remote URLs, exports, commits, or logs.

## How it fits the project

`browser-repos` is repo **2 of 5** in the Skeleton Crew project. It is consumed as a
**pinned** dependency behind an interface; no app imports its internals directly.

| Repo | Role |
|---|---|
| [user-tailored-ui](https://github.com/taylor-made-labs/user-tailored-ui) | Reusable skeleton, shared customization, contracts, main submission |
| [TailoredUI](https://github.com/taylor-made-labs/TailoredUI) | Fork — reusable UI capability (MIT, upstream: Aman Singh) |
| **browser-repos** (this) | IndexedDB-backed Git library (independent, reusable) |
| [user-tailored-planner](https://github.com/taylor-made-labs/user-tailored-planner) | Planner app |
| [user-tailored-inventory](https://github.com/taylor-made-labs/user-tailored-inventory) | Inventory app |

In the product it stores **customization history**, scoped per user+app and kept separate
from business data and creator-owned source.

## Getting started _(planned)_

Build and test are verified in **GitHub Actions CI** (the dev sandbox has no public network).

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

## Licensing

Dual-licensed under either **MIT** ([LICENSE-MIT](LICENSE-MIT)) or **Apache-2.0**
([LICENSE-APACHE](LICENSE-APACHE)), at your option. Third-party and upstream attributions
are in [NOTICE](NOTICE).

## Limitations

- This is a **seed**. The Git engine, storage layer, and export/import are not yet
  implemented; the scope above describes intent, not current capability.
- Browser storage (IndexedDB) can be evicted by the browser and is **not a backup**. Quota
  errors and storage loss will be surfaced clearly once storage lands.

## Kiro & Kiroween 2026

Built with [Kiro](https://kiro.dev) using a spec-driven workflow for **Kiroween 2026**.
Specs, steering, and development evidence live in the public [`.kiro/`](.kiro/) directory.
