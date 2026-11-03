/**
 * browser-repos
 *
 * IndexedDB-backed, Git-compatible repository library for the browser.
 *
 * This is the public entry point. The library core is framework-agnostic and
 * free of UI, LLM calls, and app logic — it is reusable outside the Skeleton
 * Crew project. Real functionality (repos, file read/write, status, staging,
 * commits, branches, history, export/import) is added behind this surface in
 * follow-up specs; see `.kiro/specs/`.
 */

/** Library semantic version, exposed for consumers and diagnostics. */
export const VERSION = '0.1.0';
