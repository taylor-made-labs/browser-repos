# Specs — browser-repos

Spec-driven development for this library lives here. Each capability is specified as a
folder containing `requirements.md`, `design.md`, and `tasks.md`, iterated with the PM
before any large build.

**Status:** placeholder. No capability specs have been written yet — this repo is a seed.

Planned first specs (not yet started):

- `repo-storage` — IndexedDB-backed filesystem (LightningFS) and repo lifecycle: create,
  open, reopen, multiple repositories.
- `git-core` — file read/write, status, staging, commits, branches/checkouts, history over
  isomorphic-git.
- `export-import` — lossless export/import of the working tree, `.git`, binaries, staged +
  untracked files, branches, and history, with path and archive-entry validation.

These are intentions, not commitments; the PM confirms scope and order before work begins.
