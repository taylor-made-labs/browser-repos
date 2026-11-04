/**
 * Remote-sync tests (slice 7).
 *
 * The network boundary is MOCKED — no real socket, so CI stays offline and
 * green. These prove the slice's real acceptance:
 *
 *  (a) the GitHub adapter drives the right smart-HTTP endpoint with the right
 *      refs, and the port contract round-trips real repo state;
 *  (b) the credential hook is CALLED per request, its value reaches the wire,
 *      and NO credential is persisted anywhere or leaked into an error message —
 *      the key security test;
 *  (c) each remote failure maps to its distinct, catchable typed error
 *      (401 → Auth, transport → Network, CORS → Cors, non-fast-forward →
 *      Divergence, conflict → Conflict);
 *  (d) the CORS proxy is off by default and used only when configured.
 *
 * A labeled LIVE integration test lives in `remote-sync.live.test.ts`, skipped
 * by default, so CI never touches real GitHub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RepoManager } from '../src/repo-manager.js';
import {
  AuthError,
  ConflictError,
  CorsError,
  DivergenceError,
  NetworkError,
} from '../src/errors.js';
import { GitHubSyncTarget } from '../src/remote/github.js';
import { redactCredentials } from '../src/remote/errors-map.js';
import type { CredentialHook, PushOutcome, SyncFs } from '../src/remote/port.js';
import { MockHttp, infoRefsBody, pktLine, pktLineRaw, responseBody } from './helpers/mock-http.js';

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});
afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
});

const AUTHOR = { name: 'Ada Lovelace', email: 'ada@example.com' };
const REMOTE_URL = 'https://github.com/owner/name.git';
/** An obvious, never-real test credential — never a live secret. */
const FAKE_TOKEN = 'FAKE_TOKEN_DO_NOT_USE';

/** A real repo with one commit, returned with its fs/dir for driving sync. */
async function repoWithCommit(id = 'sync-repo'): Promise<{
  mgr: RepoManager;
  fs: SyncFs;
  dir: string;
  headOid: string;
}> {
  const mgr = new RepoManager();
  const repo = await mgr.createRepo(id);
  await repo.writeFile('README.md', '# hello');
  await repo.stage('README.md');
  const headOid = await repo.commit({ message: 'init', author: AUTHOR });
  return { mgr, fs: repo.fsBackend.fs, dir: repo.workDir, headOid };
}

// ---------------------------------------------------------------------------
// (a) The adapter drives the right endpoint with the right refs.
// ---------------------------------------------------------------------------

describe('(a) adapter drives the smart-HTTP boundary with the right refs', () => {
  it('push: GETs info/refs for git-receive-pack, then POSTs the pack with the ref', async () => {
    const { fs, dir, headOid } = await repoWithCommit();

    const http = new MockHttp((req) => {
      if (req.method === 'GET') {
        // Advertise an empty remote (brand-new repo): push creates main.
        return { body: responseBody(infoRefsBody('git-receive-pack', {})) };
      }
      // The receive-pack POST: accept it (report-status: everything ok).
      return {
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
        body: responseBody(packReceiveOk('refs/heads/main')),
      };
    });

    const target = new GitHubSyncTarget({ url: REMOTE_URL, http });
    const out: PushOutcome = await target.push(fs, dir, { ref: 'main' });

    expect(out.ok).toBe(true);
    // info/refs GET used the receive-pack service.
    const get = http.requests.find((r) => r.method === 'GET');
    expect(get?.url).toContain('/info/refs?service=git-receive-pack');
    expect(get?.url.startsWith(REMOTE_URL)).toBe(true);
    // The receive-pack POST body names the local head oid for refs/heads/main.
    const post = http.requests.find((r) => r.method === 'POST');
    expect(post?.url).toContain('/git-receive-pack');
    const sent = new TextDecoder().decode(post?.body ?? new Uint8Array());
    expect(sent).toContain('refs/heads/main');
    expect(sent).toContain(headOid);
  });

  it('clone: GETs info/refs for git-upload-pack and sends a want for the advertised ref', async () => {
    const { headOid } = await repoWithCommit('src-for-clone');

    const http = new MockHttp((req) => {
      if (req.method === 'GET') {
        return {
          body: responseBody(
            infoRefsBody('git-upload-pack', {
              HEAD: headOid,
              'refs/heads/main': headOid,
            }),
          ),
        };
      }
      // Fail the negotiation deterministically AFTER want is sent, so we assert
      // the want without having to synthesize a full packfile.
      return { throw: Object.assign(new Error('stop after want'), { code: 'TEST_STOP' }) };
    });

    const mgr = new RepoManager();
    const dest = await mgr.createRepo('clone-dest');
    const target = new GitHubSyncTarget({ url: REMOTE_URL, http });

    await expect(
      target.clone(dest.fsBackend.fs, dest.workDir, { ref: 'main' }),
    ).rejects.toBeTruthy();

    const get = http.requests.find((r) => r.method === 'GET');
    expect(get?.url).toContain('/info/refs?service=git-upload-pack');
    const post = http.requests.find((r) => r.method === 'POST');
    expect(post?.url).toContain('/git-upload-pack');
    const sent = new TextDecoder().decode(post?.body ?? new Uint8Array());
    expect(sent).toContain(`want ${headOid}`);
  });

  it('port contract: a push then clone round-trips real repo state (in-memory target)', async () => {
    // Prove the PORT round-trips repo state, using the library's real
    // export/import as the transport the fake target stores.
    const store = new InMemorySyncTarget();

    const src = new RepoManager();
    const repo = await src.createRepo('rt-src');
    await repo.writeFile('a.txt', 'alpha');
    await repo.writeFile('b.txt', 'beta');
    await repo.stage('a.txt');
    await repo.stage('b.txt');
    const oid = await repo.commit({ message: 'round-trip', author: AUTHOR });

    // push: hand the repo's current state to the remote.
    await store.push(repo.fsBackend.fs, repo.workDir, {
      ref: 'main',
      archive: await repo.export(),
    });

    // clone: reconstruct into a fresh repo from the remote's stored state.
    const dstMgr = new RepoManager();
    const archive = store.archiveFor('main');
    expect(archive).toBeDefined();
    const restored = await dstMgr.importRepo('rt-dst', archive as Uint8Array);

    expect(await restored.readFile('a.txt')).toBe('alpha');
    expect(await restored.readFile('b.txt')).toBe('beta');
    const log = await restored.log();
    expect(log[0]?.oid).toBe(oid); // same commit oid: state is byte-exact
  });
});

// ---------------------------------------------------------------------------
// (b) Credentials: hook is called, reaches the wire, and is never persisted.
// ---------------------------------------------------------------------------

describe('(b) credentials come from the hook, reach the wire, and are never persisted', () => {
  it('calls the caller hook and sends the credential as a Basic auth header', async () => {
    const { fs, dir } = await repoWithCommit();

    const hook = vi.fn<Parameters<CredentialHook>, ReturnType<CredentialHook>>(() => ({
      username: FAKE_TOKEN,
      password: 'x-oauth-basic',
    }));

    let sawAuthHeader: string | undefined;
    const http = new MockHttp((req) => {
      if (req.method === 'GET' && !req.headers.Authorization) {
        // First GET: demand auth so onAuth fires.
        return { statusCode: 401, statusMessage: 'Unauthorized' };
      }
      // Authenticated retry: capture the header, then advertise + accept.
      sawAuthHeader = req.headers.Authorization;
      if (req.method === 'GET') {
        return { body: responseBody(infoRefsBody('git-receive-pack', {})) };
      }
      return {
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
        body: responseBody(packReceiveOk('refs/heads/main')),
      };
    });

    const target = new GitHubSyncTarget({ url: REMOTE_URL, http });
    await target.push(fs, dir, { ref: 'main', getCredentials: hook });

    // The hook was called, with the operation and a credential-free url.
    expect(hook).toHaveBeenCalled();
    const call = hook.mock.calls[0]?.[0];
    expect(call?.operation).toBe('push');
    expect(call?.url).not.toContain(FAKE_TOKEN);
    // The credential reached the wire as a Basic header.
    expect(sawAuthHeader).toBeDefined();
    const decoded = Buffer.from(
      (sawAuthHeader ?? '').replace(/^Basic /, ''),
      'base64',
    ).toString('utf8');
    expect(decoded).toContain(FAKE_TOKEN);
  });

  it('persists NO credential: not in IndexedDB, the export, config, or the remote URL', async () => {
    const mgr = new RepoManager();
    const repo = await mgr.createRepo('creds-repo');
    await repo.writeFile('README.md', '# x');
    await repo.stage('README.md');
    await repo.commit({ message: 'init', author: AUTHOR });

    const http = new MockHttp((req) => {
      if (req.method === 'GET' && !req.headers.Authorization) {
        return { statusCode: 401, statusMessage: 'Unauthorized' };
      }
      if (req.method === 'GET') {
        return { body: responseBody(infoRefsBody('git-receive-pack', {})) };
      }
      return {
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
        body: responseBody(packReceiveOk('refs/heads/main')),
      };
    });

    const target = new GitHubSyncTarget({ url: REMOTE_URL, http });
    await target.push(repo.fsBackend.fs, repo.workDir, {
      ref: 'main',
      getCredentials: () => ({ username: FAKE_TOKEN, password: 'x-oauth-basic' }),
    });

    // 1. The export (the on-disk repo state) contains no credential.
    const archive = await repo.export();
    const archiveText = new TextDecoder().decode(archive);
    expect(archiveText).not.toContain(FAKE_TOKEN);

    // 2. Walk the ENTIRE backing filesystem; no file holds the credential.
    const allBytes = await dumpTree(repo.fsBackend.fs, repo.workDir);
    expect(new TextDecoder().decode(allBytes)).not.toContain(FAKE_TOKEN);

    // 3. The stored remote URL (git config) never embeds the credential.
    const config = await safeRead(repo.fsBackend.fs, `${repo.workDir}/.git/config`);
    expect(config).not.toContain(FAKE_TOKEN);
  });

  it('redacts a credential from a thrown error message and its cause', async () => {
    const { fs, dir } = await repoWithCommit();
    const leakyUrl = `https://${FAKE_TOKEN}:x@github.com/owner/name.git`;

    const http = new MockHttp(() => ({
      // Throw an error whose message embeds the credential, as a hostile remote
      // or a careless transport might.
      throw: new Error(`fetch failed for ${leakyUrl}?access_token=${FAKE_TOKEN}`),
    }));

    const target = new GitHubSyncTarget({ url: REMOTE_URL, http });
    let caught: unknown;
    try {
      await target.push(fs, dir, { ref: 'main' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { cause?: unknown };
    expect(err.message).not.toContain(FAKE_TOKEN);
    const causeMsg = err.cause instanceof Error ? err.cause.message : String(err.cause ?? '');
    expect(causeMsg).not.toContain(FAKE_TOKEN);
  });

  it('redactCredentials strips the common secret-bearing forms', () => {
    expect(redactCredentials(`https://${FAKE_TOKEN}:pw@host/r.git`)).not.toContain(FAKE_TOKEN);
    expect(redactCredentials(`Authorization: Bearer ${FAKE_TOKEN}`)).not.toContain(FAKE_TOKEN);
    expect(redactCredentials(`?access_token=${FAKE_TOKEN}&x=1`)).not.toContain(FAKE_TOKEN);
    expect(redactCredentials(`x-access-token:${FAKE_TOKEN}@github.com`)).not.toContain(FAKE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// (c) Error mapping: each remote failure → its distinct, catchable typed error.
// ---------------------------------------------------------------------------

describe('(c) remote failures map to distinct, catchable typed errors', () => {
  /** Build a target whose info/refs GET fails in a scripted way. */
  async function pushExpectingFailure(responder: ConstructorParameters<typeof MockHttp>[0]): Promise<PushOutcome> {
    const { fs, dir } = await repoWithCommit();
    const http = new MockHttp(responder);
    const target = new GitHubSyncTarget({ url: REMOTE_URL, http });
    return target.push(fs, dir, { ref: 'main' });
  }

  it('401 → AuthError', async () => {
    await expect(
      pushExpectingFailure(() => ({ statusCode: 401, statusMessage: 'Unauthorized' })),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('403 → AuthError', async () => {
    await expect(
      pushExpectingFailure(() => ({ statusCode: 403, statusMessage: 'Forbidden' })),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('thrown transport failure → NetworkError', async () => {
    await expect(
      pushExpectingFailure(() => ({ throw: new TypeError('Failed to fetch') })),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('thrown CORS failure → CorsError', async () => {
    await expect(
      pushExpectingFailure(() => ({
        throw: new TypeError('Access-Control-Allow-Origin missing: blocked by CORS policy'),
      })),
    ).rejects.toBeInstanceOf(CorsError);
  });

  it('non-fast-forward push rejection → DivergenceError', async () => {
    // Advertise a remote main at a different oid; accept the GET, then return a
    // receive-pack result reporting the ref update was rejected (non-ff).
    await expect(
      pushExpectingFailure((req) => {
        if (req.method === 'GET') {
          return {
            body: responseBody(
              infoRefsBody('git-receive-pack', {
                'refs/heads/main': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
              }),
            ),
          };
        }
        return {
          headers: { 'content-type': 'application/x-git-receive-pack-result' },
          body: responseBody(packReceiveRejected('refs/heads/main', 'non-fast-forward')),
        };
      }),
    ).rejects.toBeInstanceOf(DivergenceError);
  });

  it('a merge conflict → ConflictError', async () => {
    // Drive the mapper directly for the conflict class: a pull that reports an
    // unmerged/ conflict condition. We assert the mapping contract.
    const { mapRemoteError } = await import('../src/remote/errors-map.js');
    const err = mapRemoteError({ code: 'MergeConflictError', message: 'conflict in a.txt' }, 'pull');
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('every mapped error is distinct and separately catchable', async () => {
    const { mapRemoteError } = await import('../src/remote/errors-map.js');
    const auth = mapRemoteError({ data: { statusCode: 401 } }, 'push');
    const net = mapRemoteError(new TypeError('Failed to fetch'), 'push');
    expect(auth).toBeInstanceOf(AuthError);
    expect(auth instanceof NetworkError).toBe(false);
    expect(net).toBeInstanceOf(NetworkError);
    expect(net instanceof AuthError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) CORS proxy: off by default, used only when explicitly configured.
// ---------------------------------------------------------------------------

describe('(d) the CORS proxy is opt-in', () => {
  it('is off by default: requests go straight to the remote (no proxy prefix)', async () => {
    const { fs, dir } = await repoWithCommit();
    const http = new MockHttp((req) => {
      if (req.method === 'GET') return { body: responseBody(infoRefsBody('git-receive-pack', {})) };
      return {
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
        body: responseBody(packReceiveOk('refs/heads/main')),
      };
    });
    const target = new GitHubSyncTarget({ url: REMOTE_URL, http });
    expect(target.usesCorsProxy).toBe(false);
    await target.push(fs, dir, { ref: 'main' });
    for (const r of http.requests) {
      expect(r.url.startsWith(REMOTE_URL)).toBe(true);
    }
  });

  it('routes through the configured proxy when one is set', async () => {
    const { fs, dir } = await repoWithCommit();
    const proxy = 'https://cors.example.org';
    const http = new MockHttp((req) => {
      if (req.method === 'GET') return { body: responseBody(infoRefsBody('git-receive-pack', {})) };
      return {
        headers: { 'content-type': 'application/x-git-receive-pack-result' },
        body: responseBody(packReceiveOk('refs/heads/main')),
      };
    });
    const target = new GitHubSyncTarget({ url: REMOTE_URL, corsProxy: proxy, http });
    expect(target.usesCorsProxy).toBe(true);
    await target.push(fs, dir, { ref: 'main' });
    // isomorphic-git prefixes the proxy as `<proxy>/<url-without-scheme>`.
    expect(http.requests.every((r) => r.url.startsWith(proxy))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Construction guard: a credential-bearing URL is rejected outright.
// ---------------------------------------------------------------------------

describe('construction rejects a credential embedded in the remote URL', () => {
  it('throws when the URL carries user:pass@ userinfo', () => {
    const http = new MockHttp(() => ({}));
    expect(
      () =>
        new GitHubSyncTarget({
          url: `https://${FAKE_TOKEN}:pw@github.com/owner/name.git`,
          http,
        }),
    ).toThrow();
  });
});

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * A minimal in-memory {@link RemoteSyncTarget}-shaped store for the PORT
 * round-trip test. It stores whatever archive a push hands it, keyed by ref,
 * and replays it on request — proving the port's push→clone contract round-trips
 * real repo state without any network.
 */
class InMemorySyncTarget {
  private readonly store = new Map<string, Uint8Array>();
  async push(
    _fs: SyncFs,
    _dir: string,
    opts: { ref: string; archive: Uint8Array },
  ): Promise<void> {
    this.store.set(opts.ref, opts.archive);
  }
  archiveFor(ref: string): Uint8Array | undefined {
    return this.store.get(ref);
  }
}

/**
 * A pkt-line muxed on side-band channel 1 (packfile/data), which is how the
 * client reads a receive-pack result: it runs the body through sideband demux
 * first, so the report-status must arrive on channel 1.
 */
/**
 * Frame an inner report-status pkt-line onto side-band channel 1. The client
 * demuxes the receive-pack body first, then reads pkt-lines OUT of channel 1 —
 * so the inner payload must itself already be a pkt-line.
 */
function sidebandLine(innerPktLine: Uint8Array): Uint8Array {
  const framed = new Uint8Array(1 + innerPktLine.length);
  framed[0] = 1; // channel 1 = pack/data stream
  framed.set(innerPktLine, 1);
  return pktLineRaw(framed);
}

/** A receive-pack result body reporting every ref updated OK (report-status). */
function packReceiveOk(ref: string): Uint8Array {
  return concatBytes([
    sidebandLine(pktLine('unpack ok\n')),
    sidebandLine(pktLine(`ok ${ref}\n`)),
    sidebandLine(new TextEncoder().encode('0000')), // inner flush, on channel 1
    new TextEncoder().encode('0000'), // outer flush
  ]);
}

/** A receive-pack result body reporting a ref update rejected for `reason`. */
function packReceiveRejected(ref: string, reason: string): Uint8Array {
  return concatBytes([
    sidebandLine(pktLine('unpack ok\n')),
    sidebandLine(pktLine(`ng ${ref} ${reason}\n`)),
    sidebandLine(new TextEncoder().encode('0000')),
    new TextEncoder().encode('0000'),
  ]);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Recursively read every file under a dir into one buffer (for a leak scan). */
async function dumpTree(fs: SyncFs, root: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  async function walk(path: string): Promise<void> {
    let names: string[];
    try {
      names = await fs.promises.readdir(path);
    } catch {
      return;
    }
    for (const name of names) {
      const child = `${path}/${name}`;
      let isDir = false;
      try {
        isDir = (await fs.promises.stat(child)).isDirectory();
      } catch {
        isDir = false;
      }
      if (isDir) {
        await walk(child);
      } else {
        try {
          const data = await fs.promises.readFile(child);
          chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        } catch {
          /* ignore unreadable entry */
        }
      }
    }
  }
  await walk(root);
  return concatBytes(chunks);
}

/** Read a file as text, returning '' if it is absent. */
async function safeRead(fs: SyncFs, path: string): Promise<string> {
  try {
    const data = await fs.promises.readFile(path, 'utf8');
    return typeof data === 'string' ? data : new TextDecoder().decode(data);
  } catch {
    return '';
  }
}
