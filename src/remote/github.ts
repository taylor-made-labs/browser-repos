/**
 * GitHub sync adapter — one implementation of {@link RemoteSyncTarget} over
 * isomorphic-git's smart-HTTP `push` / `pull` / `clone`.
 *
 * It is "GitHub" only by default configuration (the smart-HTTP transport and
 * the CORS-proxy convention); the same adapter works against any git host that
 * speaks smart HTTP over HTTPS. Nothing about it is wired into the core — it is
 * constructed and called explicitly by an app that wants sync.
 *
 * Three invariants this adapter guarantees:
 *
 * 1. **Credentials are per-request and never stored.** The caller supplies a
 *    {@link CredentialHook}; the adapter calls it immediately before each
 *    request, hands the value to isomorphic-git's `onAuth` for that one
 *    request, and keeps no reference. No credential is written to the repo,
 *    config, an export, a commit, a remote URL, or a log.
 *
 * 2. **The CORS proxy is opt-in.** There is no default proxy — the adapter
 *    sends requests straight to the remote unless the caller explicitly
 *    configures `corsProxy`.
 *
 * 3. **Errors are typed and redacted.** Every remote failure is mapped onto the
 *    library's error family via {@link mapRemoteError}, and any credential is
 *    stripped from the message by {@link redactCredentials}.
 */

import git from 'isomorphic-git';
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git/http/web';
import {
  CORS_FAILURE,
  NETWORK_FAILURE,
  mapRemoteError,
  redactCredentials,
} from './errors-map.js';
import type {
  CloneOptions,
  CredentialHook,
  PullOptions,
  PushOptions,
  PushOutcome,
  RemoteSyncTarget,
  SyncFs,
} from './port.js';

/** Construction options for {@link GitHubSyncTarget}. */
export interface GitHubSyncTargetOptions {
  /**
   * The remote repository URL, e.g. `https://github.com/owner/name.git`. It
   * must **not** embed a credential — credentials come from the per-request
   * hook, never the URL. A `user:pass@` userinfo component is rejected by the
   * constructor.
   */
  url: string;
  /**
   * Explicit, opt-in CORS proxy. Omit (the default) to send requests straight
   * to the remote with no proxy. When set, every request is routed through it
   * (isomorphic-git's `corsProxy`), e.g. `https://cors.isomorphic-git.org`.
   */
  corsProxy?: string;
  /**
   * The HTTP client. Injectable so tests can drive a mock and so an app can
   * supply the web or node transport. Defaults are not bundled here — the
   * caller passes isomorphic-git's `http/web` (browser) or `http/node`.
   */
  http: HttpClient;
}

/**
 * Wrap an {@link HttpClient} so a transport-level failure is tagged before it
 * reaches isomorphic-git, letting {@link mapRemoteError} tell a true network
 * failure from a CORS refusal. A thrown `TypeError` from `fetch` is the
 * browser's signal for *both* "offline/DNS/reset" and "CORS blocked" — the two
 * are distinguished by the message, so we tag accordingly and re-throw.
 *
 * The wrapper never inspects or logs request headers (which carry the auth
 * header for the in-flight request), so a credential cannot leak through it.
 */
function wrapHttp(inner: HttpClient): HttpClient {
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      try {
        return await inner.request(req);
      } catch (err) {
        const message = redactCredentials(
          err instanceof Error ? err.message : String(err),
        );
        const isCors = /cors|cross-origin|access-control-allow-origin/i.test(message);
        const tagged = new Error(message) as Error & { code: string };
        tagged.code = isCors ? CORS_FAILURE : NETWORK_FAILURE;
        throw tagged;
      }
    },
  };
}

/**
 * Turn the caller's {@link CredentialHook} into an isomorphic-git `onAuth`
 * callback for a single operation. The returned callback calls the hook with a
 * credential-free {@link CredentialRequest}, uses the returned value for this
 * one request, and returns it to isomorphic-git in `GitAuth` shape. It holds no
 * state across calls and stores nothing. When no hook is supplied, auth is left
 * off (anonymous request).
 */
function makeOnAuth(hook: CredentialHook | undefined, operation: 'push' | 'pull' | 'clone') {
  if (!hook) return undefined;
  return async (url: string) => {
    // Hand the hook only non-secret request facts; strip any accidental
    // userinfo from the URL we pass out.
    const creds = await hook({ url: redactCredentials(url), operation });
    if (!creds) return { cancel: true as const };
    const auth: { username?: string; password?: string; headers?: Record<string, string> } = {};
    if (creds.username !== undefined) auth.username = creds.username;
    if (creds.password !== undefined) auth.password = creds.password;
    if (creds.headers !== undefined) auth.headers = creds.headers;
    return auth;
  };
}

/**
 * A {@link RemoteSyncTarget} bound to one GitHub-style remote. Construct it with
 * the remote URL and an HTTP client; drive it with a repo's `fs` and work dir.
 */
export class GitHubSyncTarget implements RemoteSyncTarget {
  private readonly url: string;
  private readonly corsProxy: string | undefined;
  private readonly http: HttpClient;

  constructor(options: GitHubSyncTargetOptions) {
    assertCredentialFreeUrl(options.url);
    this.url = options.url;
    // Opt-in only: undefined unless the caller explicitly configured a proxy.
    this.corsProxy = options.corsProxy;
    this.http = wrapHttp(options.http);
  }

  /** Whether a CORS proxy is configured (opt-in; off by default). @internal */
  get usesCorsProxy(): boolean {
    return this.corsProxy !== undefined;
  }

  async push(fs: SyncFs, dir: string, options: PushOptions = {}): Promise<PushOutcome> {
    const onAuth = makeOnAuth(options.getCredentials, 'push');
    try {
      const result = await git.push({
        fs: fs as Parameters<typeof git.push>[0]['fs'],
        http: this.http,
        dir,
        url: this.url,
        ...(this.corsProxy !== undefined ? { corsProxy: this.corsProxy } : {}),
        ...(options.ref !== undefined ? { ref: options.ref } : {}),
        ...(options.remoteRef !== undefined ? { remoteRef: options.remoteRef } : {}),
        force: options.force ?? false,
        ...(onAuth ? { onAuth } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      // isomorphic-git resolves push even when the server rejects a ref update
      // (ok:false). Treat a rejected push as a failure and classify it.
      if (!result.ok) {
        const detail = Object.values(result.refs ?? {})
          .map((r) => r.error)
          .filter((e): e is string => typeof e === 'string')
          .join('; ');
        throw mapRemoteError(
          { message: result.error ?? detail ?? 'remote rejected the push' },
          'push',
        );
      }
      const refs: PushOutcome['refs'] = {};
      for (const [name, status] of Object.entries(result.refs ?? {})) {
        refs[name] = status.error
          ? { ok: status.ok, error: redactCredentials(status.error) }
          : { ok: status.ok };
      }
      return { ok: result.ok, refs };
    } catch (err) {
      throw rethrowTyped(err, 'push');
    }
  }

  async pull(fs: SyncFs, dir: string, options: PullOptions = {}): Promise<void> {
    const onAuth = makeOnAuth(options.getCredentials, 'pull');
    try {
      await git.pull({
        fs: fs as Parameters<typeof git.pull>[0]['fs'],
        http: this.http,
        dir,
        url: this.url,
        ...(this.corsProxy !== undefined ? { corsProxy: this.corsProxy } : {}),
        ...(options.ref !== undefined ? { ref: options.ref } : {}),
        ...(options.remoteRef !== undefined ? { remoteRef: options.remoteRef } : {}),
        fastForwardOnly: options.fastForwardOnly ?? true,
        singleBranch: true,
        ...(options.author ? { author: options.author } : {}),
        ...(onAuth ? { onAuth } : {}),
      });
    } catch (err) {
      throw rethrowTyped(err, 'pull');
    }
  }

  async clone(fs: SyncFs, dir: string, options: CloneOptions = {}): Promise<void> {
    const onAuth = makeOnAuth(options.getCredentials, 'clone');
    try {
      await git.clone({
        fs: fs as Parameters<typeof git.clone>[0]['fs'],
        http: this.http,
        dir,
        url: this.url,
        ...(this.corsProxy !== undefined ? { corsProxy: this.corsProxy } : {}),
        ...(options.ref !== undefined ? { ref: options.ref, singleBranch: true } : {}),
        ...(options.depth !== undefined ? { depth: options.depth } : {}),
        ...(onAuth ? { onAuth } : {}),
      });
    } catch (err) {
      throw rethrowTyped(err, 'clone');
    }
  }
}

/**
 * If `err` is already one of our typed errors (e.g. thrown from the `ok:false`
 * branch), pass it through; otherwise classify it. Either way, nothing raw with
 * a possible secret escapes.
 */
function rethrowTyped(err: unknown, operation: 'push' | 'pull' | 'clone'): Error {
  const code = (err as { code?: unknown })?.code;
  // Our own family already carries a stable string code; don't re-wrap it.
  if (
    code === 'NETWORK_ERROR' ||
    code === 'CORS_ERROR' ||
    code === 'AUTH_ERROR' ||
    code === 'DIVERGENCE_ERROR' ||
    code === 'CONFLICT_ERROR'
  ) {
    return err as Error;
  }
  return mapRemoteError(err, operation);
}

/**
 * Reject a remote URL that embeds a credential in its userinfo
 * (`https://user:pass@host`). Credentials must come from the per-request hook,
 * never a stored URL — this closes the most common accidental-persistence hole.
 */
function assertCredentialFreeUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid remote URL: ${redactCredentials(String(url))}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      'Remote URL must not embed a credential (user:pass@host). ' +
        'Supply credentials per request via the getCredentials hook instead.',
    );
  }
}
