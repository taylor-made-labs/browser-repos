/**
 * A scriptable mock git smart-HTTP client for the remote-sync tests.
 *
 * It mocks the ONLY network boundary the GitHub adapter has: isomorphic-git's
 * injectable {@link HttpClient}. Nothing here touches a real socket, so CI stays
 * offline. The mock does two jobs:
 *
 *  1. **Records** every request the adapter makes — method, url, headers, and
 *     the fully-buffered body — so a test can assert the adapter drove the right
 *     endpoint (`info/refs?service=…`), sent the credential the hook returned
 *     (as a `Basic` header), and routed through a CORS proxy only when one was
 *     configured.
 *  2. **Replays** scripted responses — a valid v1 `info/refs` advertisement, or
 *     a failure (401, a thrown transport/CORS error, a smart-HTTP error body) —
 *     so error-mapping can be exercised deterministically.
 *
 * The git smart-HTTP v1 framing (`pkt-line`) is small and fully implemented
 * here, so the `info/refs` responses the adapter parses are byte-real, not
 * hand-waved — the adapter runs its true parsing path against them.
 */

import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git/http/web';

/** Encode one git pkt-line (4-hex length prefix + payload) from a string. */
export function pktLine(payload: string): Uint8Array {
  return pktLineRaw(new TextEncoder().encode(payload));
}

/** Encode one git pkt-line (4-hex length prefix + payload) from raw bytes. */
export function pktLineRaw(body: Uint8Array): Uint8Array {
  const len = body.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  const out = new Uint8Array(4 + body.length);
  out.set(new TextEncoder().encode(hex), 0);
  out.set(body, 4);
  return out;
}

/** The pkt-line flush packet (`0000`). */
export const FLUSH = new TextEncoder().encode('0000');

/** Concatenate byte chunks into one buffer. */
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Wrap bytes as the one-shot async iterator isomorphic-git expects for a body. */
function bodyOf(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  let done = false;
  const it: AsyncIterableIterator<Uint8Array> = {
    next(): Promise<IteratorResult<Uint8Array>> {
      if (done) return Promise.resolve({ done: true, value: undefined });
      done = true;
      return Promise.resolve({ done: false, value: bytes });
    },
    [Symbol.asyncIterator]() {
      return it;
    },
  };
  return it;
}

/**
 * Build a byte-real git smart-HTTP v1 `info/refs` advertisement body for a
 * service, advertising the given refs. No `version 2` capability is included,
 * so the adapter's parser takes the deterministic v1 path.
 */
export function infoRefsBody(
  service: 'git-upload-pack' | 'git-receive-pack',
  refs: Record<string, string>,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  chunks.push(pktLine(`# service=${service}\n`));
  chunks.push(FLUSH);
  const entries = Object.entries(refs);
  const caps = 'side-band-64k thin-pack ofs-delta agent=mock/1';
  if (entries.length === 0) {
    chunks.push(pktLine(`0000000000000000000000000000000000000000 capabilities^{}\x00${caps}\n`));
  } else {
    entries.forEach(([name, oid], i) => {
      chunks.push(pktLine(i === 0 ? `${oid} ${name}\x00${caps}\n` : `${oid} ${name}\n`));
    });
  }
  chunks.push(FLUSH);
  return concat(chunks);
}

/** One recorded request the adapter made. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The fully-buffered request body (empty for a GET). */
  body: Uint8Array;
}

/** A scripted response, or a thrown error, keyed by how the test wants to react. */
export type Responder = (req: RecordedRequest) =>
  | Promise<Partial<GitHttpResponse> & { throw?: unknown }>
  | (Partial<GitHttpResponse> & { throw?: unknown });

/**
 * A recording, scriptable {@link HttpClient}. Pass a `responder` that returns a
 * response for each request (or `{ throw: err }` to simulate a thrown transport
 * failure). Every request is pushed onto {@link MockHttp.requests}.
 */
export class MockHttp implements HttpClient {
  readonly requests: RecordedRequest[] = [];
  constructor(private readonly responder: Responder) {}

  request = async (req: GitHttpRequest): Promise<GitHttpResponse> => {
    const body = req.body ? await drain(req.body) : new Uint8Array(0);
    const rec: RecordedRequest = {
      method: req.method ?? 'GET',
      url: req.url,
      headers: { ...(req.headers ?? {}) },
      body,
    };
    this.requests.push(rec);
    const r = await this.responder(rec);
    if (r.throw !== undefined) throw r.throw;
    return {
      url: r.url ?? req.url,
      method: rec.method,
      statusCode: r.statusCode ?? 200,
      statusMessage: r.statusMessage ?? 'OK',
      headers: r.headers ?? { 'content-type': `application/x-${service(req.url)}-advertisement` },
      body: r.body ?? bodyOf(new Uint8Array(0)),
    };
  };
}

/** Read every chunk of a request-body async iterator into one buffer. */
async function drain(it: AsyncIterableIterator<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of it) chunks.push(c);
  return concat(chunks);
}

/** Pull the `service` name out of an info/refs URL, for the default content-type. */
function service(url: string): string {
  const m = url.match(/service=(git-[a-z-]+)/);
  return m?.[1] ?? 'git-upload-pack';
}

/** Build a `GitHttpResponse`-shaped body from raw bytes (for scripted bodies). */
export function responseBody(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  return bodyOf(bytes);
}
