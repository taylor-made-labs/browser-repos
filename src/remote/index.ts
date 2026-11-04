/**
 * Optional remote-sync module.
 *
 * This is the one part of browser-repos that touches the network, and it is
 * entirely opt-in: the core repository never imports from here, so an app that
 * does not sync ships no network code. Import it only when you want to back a
 * repo up to — or restore it from — a real remote.
 *
 * - {@link RemoteSyncTarget} — the pluggable port (push / pull / clone).
 * - {@link GitHubSyncTarget} — a GitHub-style smart-HTTP adapter for the port.
 *
 * Credentials come from a caller-supplied per-request hook and are never
 * stored; failures map onto the shared typed error family. See the port's docs.
 */

export type {
  RemoteSyncTarget,
  SyncFs,
  SyncCredentials,
  CredentialRequest,
  CredentialHook,
  SyncOptions,
  PushOptions,
  PullOptions,
  CloneOptions,
  PushOutcome,
} from './port.js';

export { GitHubSyncTarget } from './github.js';
export type { GitHubSyncTargetOptions } from './github.js';

export { redactCredentials } from './errors-map.js';
