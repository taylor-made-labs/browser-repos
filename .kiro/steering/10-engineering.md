---
inclusion: always
---

# browser-repos — engineering conventions

- **Language:** TypeScript in **strict** mode (plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`). No `any` (lint enforces it).
- **Framework-agnostic:** no UI framework imports in the library. Consumers wire it behind
  an interface.
- **Dependencies:** **pinned exact versions**, committed lockfile, bundled for MV3. CI runs
  `npm ci` so the lockfile is authoritative.
- **Build/test:** `tsc` for build and typecheck, `vitest` for tests, `eslint` for lint.
- **Errors:** surface storage/quota, network/CORS/auth, and divergence/conflict errors
  **distinctly**. Prioritise local recovery before sync.
- **Durability:** treat browser memory as disposable; do not assume an awaited write is
  crash-safe. Establish durability with evidence (real MV3 workers, abrupt termination,
  reopen) rather than assuming it.
- **Reversible choices:** prefer implementation choices that are easy to change; bring
  scope, cost, security, and licensing decisions to the PM.
