/**
 * Map a raw remote/transport failure onto the library's typed error family, and
 * redact any credential before the error ever carries a message.
 *
 * Two concerns live here, deliberately together, because both are about what a
 * thrown error is allowed to contain:
 *
 * 1. **Redaction.** A credential must never reach a message, a log, or a
 *    `cause` a caller might print. {@link redactCredentials} strips the common
 *    secret-bearing forms — `user:pass@host` in a URL, `Authorization` /
 *    `token=` / `access_token=` query or header fragments — from any string
 *    before it is used in an error.
 *
 * 2. **Classification.** {@link mapRemoteError} turns an isomorphic-git / fetch
 *    failure into exactly one of {@link NetworkError}, {@link CorsError},
 *    {@link AuthError}, {@link DivergenceError}, {@link ConflictError} so a
 *    caller can `catch` the precise family. The original error is attached as
 *    `cause` — but only after its message has been run through redaction, so a
 *    secret embedded in the underlying error cannot leak out through the cause.
 */

import {
  AuthError,
  ConflictError,
  CorsError,
  DivergenceError,
  NetworkError,
  type BrowserReposError,
} from '../errors.js';

/** Sentinel the adapter's http wrapper tags a CORS-class transport failure with. */
export const CORS_FAILURE = 'BROWSER_REPOS_CORS_FAILURE';
/** Sentinel the adapter's http wrapper tags a network-transport failure with. */
export const NETWORK_FAILURE = 'BROWSER_REPOS_NETWORK_FAILURE';

/**
 * Redact credential-bearing fragments from a string so no secret survives into
 * an error message, log line, or `cause`. Conservative by design: it would
 * rather over-redact a token-shaped fragment than let one through.
 */
export function redactCredentials(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input;
  // userinfo in a URL: scheme://user:pass@host  →  scheme://***@host
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
  // Authorization header value (Basic/Bearer/token …).
  out = out.replace(
    /(authorization\s*[:=]\s*)(?:basic|bearer|token)\s+[^\s,;"']+/gi,
    '$1***',
  );
  // token / access_token / password query or form fragments.
  out = out.replace(
    /((?:access_token|token|password|private_token|pat)=)[^\s&"'#]+/gi,
    '$1***',
  );
  // x-access-token:<token>@  (GitHub token-in-URL convention).
  out = out.replace(/x-access-token:[^@\s]+/gi, 'x-access-token:***');
  return out;
}

/** Extract a `code`/`name` discriminator from an unknown thrown value. */
function errCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  const name = (err as { name?: unknown }).name;
  if (typeof code === 'string') return code;
  if (typeof name === 'string') return name;
  return undefined;
}

/** Pull an HTTP status code out of an isomorphic-git `HttpError`, if present. */
function statusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const data = (err as { data?: { statusCode?: unknown } }).data;
  const sc = data?.statusCode;
  if (typeof sc === 'number') return sc;
  const top = (err as { statusCode?: unknown }).statusCode;
  return typeof top === 'number' ? top : undefined;
}

/** The redacted message of an unknown thrown value (never its raw form). */
function safeMessage(err: unknown): string {
  const raw =
    typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : String(err);
  return redactCredentials(raw);
}

/** Does this error look like a browser CORS refusal? */
function looksLikeCors(err: unknown, msg: string): boolean {
  if (errCode(err) === CORS_FAILURE) return true;
  return /cors|cross-origin|access-control-allow-origin/i.test(msg);
}

/** Does this error look like a transport-level network failure (no response)? */
function looksLikeNetwork(err: unknown, msg: string): boolean {
  if (errCode(err) === NETWORK_FAILURE) return true;
  // fetch throws a TypeError "Failed to fetch" / "NetworkError when attempting…".
  if (err instanceof TypeError) return true;
  return /failed to fetch|network\s*error|networkerror|econn|enotfound|etimedout|dns|socket hang up|aborted/i.test(
    msg,
  );
}

/**
 * Map one raw failure from `push` / `pull` / `clone` onto a single typed error.
 *
 * Classification order (most specific first):
 *  - 401 / 403 → {@link AuthError}
 *  - CORS sentinel or CORS-shaped message → {@link CorsError}
 *  - non-fast-forward / push-rejected / fast-forward-only → {@link DivergenceError}
 *  - merge conflict / unmerged paths → {@link ConflictError}
 *  - transport failure (TypeError, network sentinel, ECONN…) → {@link NetworkError}
 *  - anything else that reached the wire → {@link NetworkError} (safe default:
 *    it is a remote-op failure, and a retry/offline path is the usual response)
 *
 * The underlying error is attached as `cause` only after its message is
 * redacted, so a secret in the original can never leak through.
 */
export function mapRemoteError(err: unknown, operation: 'push' | 'pull' | 'clone'): BrowserReposError {
  const code = errCode(err);
  const msg = safeMessage(err);
  const status = statusCode(err);
  // Attach a redacted shadow of the cause — never the raw error, which may
  // carry a secret in its message/stack.
  const cause = new Error(msg);

  if (status === 401 || status === 403 || /\b401\b|\b403\b|unauthor|forbidden/i.test(msg)) {
    return new AuthError(
      `Remote rejected the ${operation}: authentication failed or was insufficient.`,
      cause,
    );
  }

  if (looksLikeCors(err, msg)) {
    return new CorsError(
      `Remote ${operation} was blocked by the browser's cross-origin (CORS) policy. ` +
        `The host must allow this origin, or configure a CORS proxy.`,
      cause,
    );
  }

  if (
    code === 'PushRejectedError' ||
    code === 'FastForwardError' ||
    /not-fast-forward|non-fast-forward|fast.?forward|diverged|failed to update ref/i.test(msg)
  ) {
    return new DivergenceError(
      `Remote ${operation} could not fast-forward: local and remote histories have diverged.`,
      cause,
    );
  }

  if (
    code === 'MergeConflictError' ||
    code === 'MergeNotSupportedError' ||
    code === 'UnmergedPathsError' ||
    /conflict|unmerged/i.test(msg)
  ) {
    return new ConflictError(
      `Remote ${operation} produced a merge conflict that needs resolution.`,
      cause,
    );
  }

  if (looksLikeNetwork(err, msg)) {
    return new NetworkError(
      `Remote ${operation} failed at the network layer: the remote could not be reached.`,
      cause,
    );
  }

  // Reached the wire but did not classify: treat as a network-class failure so
  // the caller's retry/offline handling applies, rather than leaking a raw error.
  return new NetworkError(`Remote ${operation} failed: ${msg}`, cause);
}
