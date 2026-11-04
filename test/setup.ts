/**
 * Test setup: provide an in-process IndexedDB so LightningFS runs under Node.
 *
 * `fake-indexeddb/auto` installs a spec-compliant IndexedDB on the global, and
 * it persists across separate LightningFS handles within one process — which is
 * exactly what lets us exercise real close-and-reopen durability in the suite.
 */
import 'fake-indexeddb/auto';

/**
 * LightningFS's DefaultBackend reads `navigator.locks` to pick its mutex: the
 * Web Locks API (Mutex2) when present, otherwise an IndexedDB-backed mutex
 * (Mutex). Two problems under Node:
 *   1. Node 20 (our CI) has no global `navigator` at all → it throws before the
 *      fallback is reached.
 *   2. Newer Node (e.g. 21+) DOES expose `navigator.locks`, so tests would take
 *      the Web Locks path locally but the IndexedDB path on CI — different code
 *      under test.
 * Pin a `navigator` with no `locks` so LightningFS always takes the
 * IndexedDB-backed mutex path — the one fake-indexeddb supports — identically in
 * every Node version. The library itself never reads navigator; this only shapes
 * the Node test environment.
 */
Object.defineProperty(globalThis, 'navigator', {
  value: {},
  configurable: true,
  writable: true,
});
