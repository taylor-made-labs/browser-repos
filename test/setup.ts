/**
 * Test setup: provide an in-process IndexedDB so LightningFS runs under Node.
 *
 * `fake-indexeddb/auto` installs a spec-compliant IndexedDB on the global, and
 * it persists across separate LightningFS handles within one process — which is
 * exactly what lets us exercise real close-and-reopen durability in the suite.
 */
import 'fake-indexeddb/auto';
