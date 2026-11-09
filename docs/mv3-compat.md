# MV3 compatibility: what is proven and what is not

Manifest V3 service workers forbid remotely hosted code, `eval`, and `new Function`. They
have no `window`, `document`, or `localStorage`. They do have IndexedDB.

## Proven (by `test/mv3-compat.test.ts`, runs in CI)

| Claim | How it is checked |
|---|---|
| No `eval`, `new Function`, `importScripts`, remote `import()`, remote script tags | Static scan of `src/` plus the sources of `isomorphic-git` and `@isomorphic-git/lightning-fs` (comments stripped) |
| No `localStorage`, no `chrome.storage` | Same scan |
| Only `src/remote/` can reach the network | Same scan finds no `fetch`, `XMLHttpRequest` or URL outside `src/remote/` |
| A full round-trip (write, stage, commit, branch, checkout, export, import) works with no `window`, `document`, `localStorage`, `chrome`, and with `fetch` poisoned | Runtime test in Node with `fake-indexeddb` |

## NOT proven

- **No real extension run.** Nothing here loads the library in Chrome as an MV3 service
  worker. That needs a browser and a built extension, and a human to run it.
- **The scan reads source, not a bundle.** An extension bundler can add code. Scan your own
  bundle too.
- **`fake-indexeddb` is not a browser.** Real quota, eviction and transaction timing can
  differ. See `DURABILITY.md`.
- **Dependencies are scanned at the pinned versions only** (`isomorphic-git` 1.44.10,
  `lightning-fs` 4.10.5).
- **Remote sync** (`src/remote/`) uses `fetch` by design and only on explicit call. An MV3
  extension needs `host_permissions` for the remote host. Not tested in an extension.
