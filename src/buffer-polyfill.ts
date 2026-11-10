/**
 * isomorphic-git reads a global `Buffer` at call time (Node has one, browsers do not).
 * Install the `buffer` package's implementation when the host lacks one, so the library
 * works in a page, worker or MV3 service worker with no Node globals. Import this
 * module before any isomorphic-git use. A host that already has `Buffer` is left alone.
 */
import { Buffer } from 'buffer';

const g = globalThis as { Buffer?: unknown };
if (g.Buffer === undefined) g.Buffer = Buffer;
