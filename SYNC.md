# Remote sync

Browser storage is **not a backup**. IndexedDB can be evicted under storage
pressure, wiped by "clear browsing data", or lost with a profile. The
`RemoteSyncTarget` port is how an app protects a repo against that: it pushes the
repo's git data to a real remote and pulls it back. This document covers the
port, the GitHub adapter, the credential contract, the CORS-proxy opt-in, and the
typed errors.

## What stays true no matter what

- **The core never touches the network.** Lifecycle, git ops, branches,
  export/import and durability carry no network code and no dependency on this
  module. An app that never calls a sync method ships no network surface.
- **Sync is caller-driven.** Nothing is pushed or pulled unless you explicitly
  call `push`, `pull`, or `clone`. There is no background sync and no implicit
  write.
- **The library never stores a credential.** See [Credentials](#credentials).

## The port

`RemoteSyncTarget` is the pluggable contract. GitHub is one adapter; any git host
(or a test double) can implement the same interface, and repo logic only ever
sees the port.

```ts
interface RemoteSyncTarget {
  push(fs, dir, options?): Promise<PushOutcome>;
  pull(fs, dir, options?): Promise<void>;
  clone(fs, dir, options?): Promise<void>;
}
```

`fs` is the repo's filesystem (`repo.fsBackend.fs`) and `dir` its working
directory (`repo.workDir`). Each method drives the repo's `.git` directly and
never reads app state.

## The GitHub adapter

`GitHubSyncTarget` implements the port over isomorphic-git's smart-HTTP
`push` / `pull` / `clone`. It is "GitHub" only by default convention; it works
against any host that speaks smart HTTP over HTTPS.

```ts
import { GitHubSyncTarget } from '@taylor-made-labs/browser-repos';
import http from 'isomorphic-git/http/web'; // or 'isomorphic-git/http/node'

const remote = new GitHubSyncTarget({
  url: 'https://github.com/you/backup.git', // MUST NOT embed a credential
  http,
  // corsProxy: 'https://cors.isomorphic-git.org', // opt-in; off by default
});
```

You supply the `http` client for your environment. The library does not bundle a
transport into this adapter, so a browser app and a Node tool each pass the right
one. A URL that embeds a credential (`https://user:pass@host`) is **rejected by
the constructor** — credentials come from the per-request hook, never the URL.

## Credentials

This is the load-bearing invariant. **The library never stores a credential.**

- You provide a credential **per request** through a `getCredentials` hook.
- The adapter calls the hook immediately before each request, uses the returned
  value in memory for that one request, and keeps no reference to it.
- A credential is **never** written to IndexedDB, repo data, git config, an
  export, a commit, a remote URL, or a log.
- Any credential is **redacted** from the message (and the `cause`) of every
  error this module throws.

```ts
await remote.push(repo.fsBackend.fs, repo.workDir, {
  ref: 'main',
  getCredentials: ({ url, operation }) => {
    // url is credential-free; operation is 'push' | 'pull' | 'clone'.
    return { username: myToken, password: 'x-oauth-basic' };
    // or a bearer token: { headers: { Authorization: `Bearer ${myToken}` } }
  },
});
```

Return `undefined` (or supply no hook) to attempt an unauthenticated request —
useful for cloning or pulling a public repo. A remote that then requires auth
surfaces as `AuthError`.

Where the token itself lives is **your** decision, outside this library — an
in-memory variable, a prompt, a platform keychain. The library's job is only to
guarantee it never leaks into persisted repo data.

## The CORS proxy is opt-in

In a browser, a git host that does not send the right CORS headers needs a proxy.
There is **no default proxy**: requests go straight to the remote unless you set
`corsProxy` on the constructor. When set, every request is routed through it.

```ts
new GitHubSyncTarget({ url, http, corsProxy: 'https://cors.isomorphic-git.org' });
```

Leave it unset for a Node tool (`isomorphic-git/http/node`), or for a browser
host that already allows your origin.

## Typed errors

Every remote failure maps onto one distinct, `catch`-able error from the shared
taxonomy (see the README's error table). The credential is redacted before the
error carries any message.

| Failure | Error |
|---|---|
| Offline / DNS / timeout / reset (no response) | `NetworkError` |
| Browser blocked the response on CORS policy | `CorsError` |
| Remote rejected the credential (401 / 403) | `AuthError` |
| Local and remote history diverged (non-fast-forward) | `DivergenceError` |
| A merge produced conflicting edits | `ConflictError` |

```ts
import { AuthError, DivergenceError } from '@taylor-made-labs/browser-repos';

try {
  await remote.push(fs, dir, { ref: 'main', getCredentials });
} catch (err) {
  if (err instanceof AuthError) promptForToken();
  else if (err instanceof DivergenceError) await remote.pull(fs, dir, { ref: 'main', getCredentials });
  else throw err;
}
```

By default `push` refuses a non-fast-forward update (it throws `DivergenceError`
rather than overwriting remote history) unless you pass `force: true`, and `pull`
is fast-forward-only unless you opt into a merge.

## A practical backup loop

```ts
// After meaningful local commits, back up:
try {
  await remote.push(repo.fsBackend.fs, repo.workDir, { ref: 'main', getCredentials });
} catch (err) {
  if (err instanceof DivergenceError) {
    // Someone else advanced the remote — reconcile, then push again.
    await remote.pull(repo.fsBackend.fs, repo.workDir, { ref: 'main', getCredentials });
    await remote.push(repo.fsBackend.fs, repo.workDir, { ref: 'main', getCredentials });
  } else {
    throw err;
  }
}

// On a fresh browser, restore into a new repo:
const restored = await new RepoManager().createRepo('restored');
await remote.clone(restored.fsBackend.fs, restored.workDir, { ref: 'main', getCredentials });
```

Pushing after meaningful changes — not browser storage — is what makes a repo
recoverable.
